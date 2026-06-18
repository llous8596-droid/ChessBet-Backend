require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const { pool, initDB, refundOrphanedGames } = require('./db');
const chess = require('./chess-engine');

const app    = express();
app.set('trust proxy', 1); // Render est derrière un proxy : nécessaire pour que req.ip soit correct
const server = http.createServer(app);

// Liste des origines autorisées (frontend séparé type Netlify + le serveur lui-même)
const allowedOrigins = [process.env.FRONTEND_URL].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Autorise les requêtes sans origine (curl, apps mobiles, requêtes same-origin)
    // et celles qui correspondent à FRONTEND_URL.
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Origine non autorisée par CORS'));
  },
  methods: ['GET', 'POST'],
};

const io = new Server(server, { cors: corsOptions });

// ── Middleware ──────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(corsOptions));
// Webhook Stripe : raw body AVANT express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes API ──────────────────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/payments', require('./routes/payments'));

// ── Parties en mémoire ──────────────────────────────────────
const games = new Map();

// ── File de matchmaking ─────────────────────────────────────
// Structure : matchQueue[timeControl][betCents] = { socketId, uid, uname, color }
// Quand un joueur cherche une partie, on vérifie si quelqu'un attend déjà
// avec la même mise et la même cadence. Si oui → on lance la partie direct.
const matchQueue = {};

// ── Rate limiting pour les événements Socket.io sensibles ───
// Empêche le spam de create_game/find_match/join_game (DoS léger, abus de matchmaking)
const socketEventBuckets = new Map(); // `${uid}:${event}` → timestamps[]
function checkSocketRateLimit(uid, event, max, windowMs) {
  const key = `${uid}:${event}`;
  const now = Date.now();
  const timestamps = (socketEventBuckets.get(key) || []).filter(t => now - t < windowMs);
  if (timestamps.length >= max) return false;
  timestamps.push(now);
  socketEventBuckets.set(key, timestamps);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of socketEventBuckets.entries()) {
    const filtered = ts.filter(t => now - t < 5 * 60 * 1000);
    if (filtered.length === 0) socketEventBuckets.delete(key);
    else socketEventBuckets.set(key, filtered);
  }
}, 5 * 60 * 1000);

// ── Auth Socket.io ──────────────────────────────────────────
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Non authentifié'));
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { next(new Error('Token invalide')); }
});

// ── Événements Socket.io ────────────────────────────────────
io.on('connection', (socket) => {
  const uid = socket.user.id;
  const uname = socket.user.username;
  console.log(`🔌 ${uname} connecté`);

  // Créer une partie : débite immédiatement la mise du créateur
  socket.on('create_game', async ({ gameId, bet, timeControl, color }) => {
    if (!checkSocketRateLimit(uid, 'create_game', 10, 60 * 1000))
      return socket.emit('error', 'Trop de tentatives, réessaie dans une minute');

    const VALID_TIME_CONTROLS = [60, 180, 300, 600, 1800];
    const MIN_BET_CENTS = 500;   // 5€
    const MAX_BET_CENTS = 500000; // 5000€

    if (!Number.isInteger(bet) || bet < MIN_BET_CENTS || bet > MAX_BET_CENTS)
      return socket.emit('error', 'Mise invalide');
    if (!VALID_TIME_CONTROLS.includes(timeControl))
      return socket.emit('error', 'Cadence invalide');
    if (color !== 'w' && color !== 'b')
      return socket.emit('error', 'Couleur invalide');
    if (games.has(gameId))
      return socket.emit('error', 'Partie déjà existante');

    // Débiter la mise du créateur (avec vérification atomique du solde)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [uid]);
      if (!r.rows.length || r.rows[0].balance < bet) {
        await client.query('ROLLBACK');
        return socket.emit('error', 'Solde insuffisant');
      }
      await client.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [bet, uid]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Erreur débit créateur:', e);
      return socket.emit('error', 'Erreur serveur');
    } finally { client.release(); }

    const isWhite = color === 'w';
    games.set(gameId, {
      id: gameId,
      creatorId: uid,
      players: { white: isWhite ? uid : null, black: isWhite ? null : uid },
      names:   { white: isWhite ? uname : null, black: isWhite ? null : uname },
      turn: 'w',
      bet,
      pot: bet * 2,
      timeControl,
      timers: { w: timeControl, b: timeControl },
      lastTick: null,
      finished: false,
      moveHistory: [],
      chessState: chess.newGameState(),
    });
    socket.join(gameId);
    socket.emit('balance_update', { delta: -bet });
    socket.emit('waiting_opponent');
    broadcastLobby();
  });

  // Reconnexion à une partie en cours (rechargement de page)
  socket.on('reconnect_game', ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.finished) return socket.emit('reconnect_failed');

    const isWhite = game.players.white === uid;
    const isBlack = game.players.black === uid;
    if (!isWhite && !isBlack) return socket.emit('reconnect_failed');

    socket.join(gameId);

    // Recalculer le temps restant
    let timers = { ...game.timers };
    if (game.lastTick) {
      const elapsed = Math.floor((Date.now() - game.lastTick) / 1000);
      timers[game.turn] = Math.max(0, timers[game.turn] - elapsed);
    }

    socket.emit('reconnect_state', {
      color: isWhite ? 'w' : 'b',
      white: game.names.white,
      black: game.names.black,
      bet: game.bet,
      pot: game.pot,
      timeControl: game.timeControl,
      turn: game.turn,
      timers,
      moveHistory: game.moveHistory,
    });
  });

  // ── MATCHMAKING ────────────────────────────────────────────
  socket.on('find_match', async ({ bet, timeControl }) => {
    if (!checkSocketRateLimit(uid, 'find_match', 15, 60 * 1000))
      return socket.emit('match_error', 'Trop de tentatives, réessaie dans une minute');

    const VALID_BETS = [500, 1000, 5000, 10000]; // 5, 10, 50, 100€ en centimes
    const VALID_TC   = [60, 180, 300, 600, 1800];

    if (!VALID_BETS.includes(bet))      return socket.emit('match_error', 'Mise invalide');
    if (!VALID_TC.includes(timeControl)) return socket.emit('match_error', 'Cadence invalide');

    // Vérifier le solde avant de mettre en file
    const r = await pool.query('SELECT balance FROM users WHERE id=$1', [uid]);
    if (!r.rows.length || r.rows[0].balance < bet)
      return socket.emit('match_error', 'Solde insuffisant');

    const key = `${timeControl}_${bet}`;

    // Si quelqu'un attend déjà dans cette file → on les match
    if (matchQueue[key] && matchQueue[key].uid !== uid) {
      const opponent = matchQueue[key];
      delete matchQueue[key];

      // Assigner les couleurs aléatoirement
      const creatorIsWhite = Math.random() < 0.5;
      const whiteId   = creatorIsWhite ? opponent.uid   : uid;
      const blackId   = creatorIsWhite ? uid             : opponent.uid;
      const whiteName = creatorIsWhite ? opponent.uname  : uname;
      const blackName = creatorIsWhite ? uname            : opponent.uname;

      // Débiter les deux joueurs en une transaction atomique
      const client = await pool.connect();
      let gameId;
      try {
        await client.query('BEGIN');

        const w = await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [whiteId]);
        const b = await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [blackId]);
        if (w.rows[0].balance < bet || b.rows[0].balance < bet) {
          await client.query('ROLLBACK');
          // Remettre l'adversaire en file si c'est lui qui n'a plus de solde
          if (b.rows[0].balance < bet) {
            socket.emit('match_error', 'L\'adversaire n\'avait plus assez de solde');
          } else {
            socket.emit('match_error', 'Solde insuffisant');
          }
          // Remettre l'opponent en file
          matchQueue[key] = opponent;
          broadcastQueueCounts();
          return;
        }

        await client.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [bet, whiteId]);
        await client.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [bet, blackId]);

        const { v4: uuidv4 } = require('uuid');
        gameId = uuidv4();
        const pot = bet * 2;

        await client.query(
          'INSERT INTO games(id,white_id,black_id,bet,pot,time_control) VALUES($1,$2,$3,$4,$5,$6)',
          [gameId, whiteId, blackId, bet, pot, timeControl]
        );
        await client.query('COMMIT');

        // Créer la partie en mémoire
        games.set(gameId, {
          id: gameId,
          players: { white: whiteId, black: blackId },
          names:   { white: whiteName, black: blackName },
          turn: 'w',
          bet,
          pot,
          timeControl,
          timers: { w: timeControl, b: timeControl },
          lastTick: Date.now(),
          finished: false,
          moveHistory: [],
          creatorId: null,
          chessState: chess.newGameState(),
        });

      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Erreur match creation:', e);
        socket.emit('match_error', 'Erreur serveur');
        matchQueue[key] = opponent;
        broadcastQueueCounts();
        return;
      } finally { client.release(); }

      // Joindre les deux sockets à la room
      const oppSocket = io.sockets.sockets.get(opponent.socketId);
      socket.join(gameId);
      if (oppSocket) oppSocket.join(gameId);

      const game = games.get(gameId);

      // Notifier les deux joueurs de leur couleur et balance
      const myColor  = whiteId === uid ? 'w' : 'b';
      const oppColor = myColor === 'w' ? 'b' : 'w';
      socket.emit('color_assigned', myColor);
      socket.emit('balance_update', { delta: -bet });
      if (oppSocket) {
        oppSocket.emit('color_assigned', oppColor);
        oppSocket.emit('balance_update', { delta: -bet });
      }

      // Démarrer la partie pour les deux
      startGameTimer(gameId);
      io.to(gameId).emit('game_start', {
        white: whiteName,
        black: blackName,
        bet:   game.bet,
        pot:   game.pot,
        timeControl,
        gameId,
      });

      broadcastLobby();
      broadcastQueueCounts();
      console.log(`🎮 Match trouvé : ${whiteName} vs ${blackName} — ${bet/100}€ — ${timeControl}s`);

    } else {
      // Personne ne attend → mettre en file d'attente
      // Si le joueur était déjà en file, le remplacer
      removeFromQueue(uid);
      matchQueue[key] = { socketId: socket.id, uid, uname, bet, timeControl };
      socket.emit('match_searching', { bet, timeControl });
      broadcastQueueCounts();
      console.log(`🔍 ${uname} cherche une partie — ${bet/100}€ — ${timeControl}s`);
    }
  });

  socket.on('cancel_match', () => {
    removeFromQueue(uid);
    socket.emit('match_cancelled');
    broadcastQueueCounts();
  });

  socket.on('join_game', async ({ gameId }) => {
    if (!checkSocketRateLimit(uid, 'join_game', 15, 60 * 1000))
      return socket.emit('error', 'Trop de tentatives, réessaie dans une minute');

    const game = games.get(gameId);
    if (!game || game.finished) return socket.emit('error', 'Partie introuvable');

    socket.join(gameId);

    // Assigner la couleur manquante (provisoirement, annulé si débit échoue)
    let assignedColor;
    if (!game.players.white) {
      assignedColor = 'w';
    } else if (!game.players.black) {
      assignedColor = 'b';
    } else {
      socket.emit('color_assigned', 'spectator');
      return;
    }

    // Débiter la mise du deuxième joueur (avec vérification atomique du solde)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [uid]);
      if (!r.rows.length || r.rows[0].balance < game.bet) {
        await client.query('ROLLBACK');
        return socket.emit('error', 'Solde insuffisant');
      }
      await client.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [game.bet, uid]);
      if (assignedColor === 'w') {
        game.players.white = uid;
        game.names.white   = uname;
      } else {
        game.players.black = uid;
        game.names.black   = uname;
      }
      await client.query(
        `INSERT INTO games(id,white_id,black_id,bet,pot,time_control) VALUES($1,$2,$3,$4,$5,$6)`,
        [gameId, game.players.white, game.players.black, game.bet, game.pot, game.timeControl]
      );
      await client.query('COMMIT');
    } catch(e) {
      await client.query('ROLLBACK');
      console.error('Erreur débit joueur 2:', e);
      return socket.emit('error', 'Erreur serveur');
    } finally { client.release(); }

    socket.emit('color_assigned', assignedColor);
    socket.emit('balance_update', { delta: -game.bet });

    // Démarrer la partie
    game.lastTick = Date.now();
    startGameTimer(gameId);
    io.to(gameId).emit('game_start', {
      white: game.names.white,
      black: game.names.black,
      bet: game.bet,
      pot: game.pot,
      timeControl: game.timeControl,
    });
    broadcastLobby();
  });

  // Recevoir un coup — VALIDÉ par le moteur d'échecs serveur (source de vérité)
  socket.on('move', ({ gameId, move }) => {
    if (!checkSocketRateLimit(uid, 'move', 30, 10 * 1000)) return; // anti-flood, généreux pour le bullet
    const game = games.get(gameId);
    if (!game || game.finished) return;
    const isWhite = game.players.white === uid;
    const isBlack = game.players.black === uid;
    if (!isWhite && !isBlack) return socket.emit('error', 'Vous ne participez pas à cette partie');

    const myColor = isWhite ? 'w' : 'b';
    if (game.turn !== myColor) return socket.emit('error', 'Pas votre tour');

    const { fr, fc, tr, tc, promo } = move || {};
    const result = chess.tryApplyMove(game.chessState, myColor, fr, fc, tr, tc, promo);
    if (!result.ok) {
      console.warn(`⚠️ Coup illégal rejeté de ${uname} (partie ${gameId}): ${result.error}`);
      return socket.emit('error', result.error);
    }

    // Coup légal et validé — on met à jour l'état autoritaire de la partie
    game.chessState = result.state;

    // Mettre à jour le timer du joueur qui vient de jouer
    const now = Date.now();
    if (game.lastTick) {
      const elapsed = Math.floor((now - game.lastTick) / 1000);
      game.timers[game.turn] = Math.max(0, game.timers[game.turn] - elapsed);
    }
    game.lastTick = now;
    game.turn = game.turn === 'w' ? 'b' : 'w';

    // Reconstruire un objet move complet (avec le flag déterminé par le serveur,
    // jamais celui envoyé par le client) pour le diffuser aux deux joueurs.
    const validatedMove = { fr, fc, tr, tc, flag: result.flag, promo: result.promo };
    game.moveHistory.push(validatedMove);

    socket.to(gameId).emit('move', { move: validatedMove, turn: game.turn, timers: game.timers });
    // Confirmer au joueur qui a joué (sans renvoyer le coup, déjà appliqué localement chez lui)
    socket.emit('move_ack', { turn: game.turn, timers: game.timers });

    // Vérifier si la partie est terminée (mat, pat, nulle) — déterminé par le serveur, jamais par le client
    const end = chess.checkGameEnd(game.chessState);
    if (end) {
      game.finished = true;
      clearGameTimer(gameId);
      io.to(gameId).emit('game_over', { result: end.result, reason: end.reason });
      settle(gameId, game, end.result, end.reason);
    }
  });

  // Annuler une partie créée si aucun adversaire n'a rejoint
  socket.on('cancel_game', async ({ gameId }) => {
    const game = games.get(gameId);
    if (!game) return;
    const isCreator = game.players.white === uid || game.players.black === uid;
    if (!isCreator) return;
    const hasOpponent = game.players.white && game.players.black;
    if (hasOpponent) return; // partie déjà commencée, doit passer par resign

    games.delete(gameId);
    clearGameTimer(gameId);

    // Remboursement de la mise du créateur
    try {
      await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [game.bet, uid]);
      socket.emit('balance_update', { delta: game.bet });
    } catch (e) {
      console.error('Erreur remboursement annulation:', e);
    }

    socket.emit('game_cancelled', {});
    broadcastLobby();
  });

  // Abandon
  socket.on('resign', ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.finished) return;
    const isWhite = game.players.white === uid;
    const isBlack = game.players.black === uid;
    if (!isWhite && !isBlack) return socket.emit('error', 'Vous ne participez pas à cette partie');
    game.finished = true;
    clearGameTimer(gameId);
    const result = isWhite ? 'black' : 'white';
    io.to(gameId).emit('game_over', { result, reason: 'resign' });
    settle(gameId, game, result, 'resign');
  });

  // Offrir la nulle
  socket.on('offer_draw', ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.finished) return;
    const isWhite = game.players.white === uid;
    const isBlack = game.players.black === uid;
    if (!isWhite && !isBlack) return;
    // Notifier l'adversaire
    socket.to(gameId).emit('draw_offered', { from: uname });
  });

  // Accepter la nulle
  socket.on('accept_draw', ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.finished) return;
    const isWhite = game.players.white === uid;
    const isBlack = game.players.black === uid;
    if (!isWhite && !isBlack) return;
    game.finished = true;
    clearGameTimer(gameId);
    io.to(gameId).emit('game_over', { result: 'draw', reason: 'accord mutuel' });
    settle(gameId, game, 'draw', 'accord mutuel');
  });

  socket.on('disconnect', async () => {
    console.log(`🔌 ${uname} déconnecté`);
    // Retirer de la file de matchmaking si en attente
    removeFromQueue(uid);
    broadcastQueueCounts();
    // Nettoyer les parties en attente créées par ce joueur (rembourser la mise)
    for (const [gameId, game] of games.entries()) {
      const hasOpponent = game.players.white && game.players.black;
      const isCreator = game.creatorId === uid;
      if (!hasOpponent && isCreator && !game.finished) {
        games.delete(gameId);
        clearGameTimer(gameId);
        try {
          await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [game.bet, uid]);
        } catch (e) {
          console.error('Erreur remboursement déconnexion:', e);
        }
        broadcastLobby();
      }
    }
  });
});

// ── Timers serveur ──────────────────────────────────────────
const gameTimers = new Map();

function startGameTimer(gameId) {
  const interval = setInterval(() => {
    const game = games.get(gameId);
    if (!game || game.finished) { clearInterval(interval); return; }
    const now = Date.now();
    const elapsed = Math.floor((now - game.lastTick) / 1000);
    const remaining = game.timers[game.turn] - elapsed;
    if (remaining <= 0) {
      game.finished = true;
      clearInterval(interval);
      const result = game.turn === 'w' ? 'black' : 'white';
      io.to(gameId).emit('game_over', { result, reason: 'timeout' });
      settle(gameId, game, result, 'timeout');
    }
  }, 1000);
  gameTimers.set(gameId, interval);
}

function clearGameTimer(gameId) {
  const t = gameTimers.get(gameId);
  if (t) { clearInterval(t); gameTimers.delete(gameId); }
}

// ── Régler les gains ────────────────────────────────────────
const COMMISSION = 0.05;

async function settle(gameId, game, result, reason) {
  const pot        = game.pot;
  const commission = Math.round(pot * COMMISSION);
  const winnerGain = pot - commission;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (result === 'draw') {
      const refund = Math.round(game.bet - commission / 2);
      if (game.players.white) {
        await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [refund, game.players.white]);
        await client.query('INSERT INTO transactions(user_id,type,amount,status) VALUES($1,$2,$3,$4)',
          [game.players.white, 'commission', Math.round(commission / 2), 'completed']);
      }
      if (game.players.black) {
        await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [refund, game.players.black]);
        await client.query('INSERT INTO transactions(user_id,type,amount,status) VALUES($1,$2,$3,$4)',
          [game.players.black, 'commission', Math.round(commission / 2), 'completed']);
      }
      // Marquer la partie comme terminée en base même en cas de nulle,
      // sinon refundOrphanedGames() la rembourserait une deuxième fois après un redémarrage.
      await client.query("UPDATE games SET finished=true, result='draw', reason=$1, commission=$2 WHERE id=$3",
        [(reason || '').slice(0, 30), commission, gameId]);
    } else {
      const winnerId = result === 'white' ? game.players.white : game.players.black;
      await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [winnerGain, winnerId]);
      await client.query('UPDATE games SET finished=true,result=$1,reason=$2,commission=$3,winner_id=$4 WHERE id=$5',
        [result, (reason || '').slice(0, 30), commission, winnerId, gameId]);
      await client.query('INSERT INTO transactions(user_id,type,amount,status) VALUES($1,$2,$3,$4)',
        [winnerId, 'commission', commission, 'completed']);
    }

    await client.query('UPDATE admin_stats SET total_commission=total_commission+$1, total_volume=total_volume+$2, total_games=total_games+1 WHERE id=1',
      [commission, pot]);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Erreur settlement:', e);
  } finally { client.release(); }

  io.to(gameId).emit('settled', { result, reason, winnerGain, commission });
  games.delete(gameId);
  broadcastLobby();
}

// ── Matchmaking helpers ─────────────────────────────────────
function removeFromQueue(uid) {
  for (const key of Object.keys(matchQueue)) {
    if (matchQueue[key].uid === uid) {
      delete matchQueue[key];
      break;
    }
  }
}

function broadcastQueueCounts() {
  // Envoie à tous les connectés le nombre de joueurs qui cherchent par mise/cadence
  const counts = {};
  for (const [key, entry] of Object.entries(matchQueue)) {
    counts[key] = (counts[key] || 0) + 1;
  }
  io.emit('queue_counts', counts);
}

// ── Lobby en temps réel ─────────────────────────────────────
function broadcastLobby() {
  const lobby = [];
  for (const [id, g] of games.entries()) {
    if (!g.finished && (!g.players.white || !g.players.black)) {
      lobby.push({ id, bet: g.bet, pot: g.pot, timeControl: g.timeControl, creator: g.names.white || g.names.black });
    }
  }
  io.emit('lobby_update', lobby);
  broadcastQueueCounts();
}

// Route REST pour le lobby (pour le chargement initial)
app.get('/api/lobby', (req, res) => {
  const lobby = [];
  for (const [id, g] of games.entries()) {
    if (!g.finished && (!g.players.white || !g.players.black))
      lobby.push({ id, bet: g.bet, pot: g.pot, timeControl: g.timeControl, creator: g.names.white || g.names.black });
  }
  res.json(lobby);
});

// 404 JSON pour les routes /api/* non trouvées (évite de renvoyer index.html en JSON)
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Route introuvable' });
});

// Toutes les autres routes (non-API) → renvoie index.html (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Gestionnaire d'erreurs global : toute erreur sur /api/* renvoie du JSON, jamais une page HTML
app.use((err, req, res, next) => {
  console.error('Erreur non gérée:', err);
  if (req.path.startsWith('/api')) {
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
  res.status(500).send('Erreur serveur');
});

// ── Démarrage ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB().then(async () => {
  await refundOrphanedGames();
  server.listen(PORT, () => console.log(`✅ ChessBet sur http://localhost:${PORT}`));
}).catch(e => { console.error('Erreur DB:', e); process.exit(1); });
