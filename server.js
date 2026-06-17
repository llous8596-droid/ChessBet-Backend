require('dotenv').config();
const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const jwt          = require('jsonwebtoken');
const path         = require('path');
const { pool, initDB } = require('./db');

const app    = express();

// Render est derrière un reverse-proxy : nécessaire pour que express-rate-limit
// et req.ip identifient correctement l'IP réelle du visiteur (sinon tout le monde
// partage la même IP vue par le serveur et se fait bloquer ensemble)
app.set('trust proxy', 1);

const server = http.createServer(app);

// ── CORS restreint à ton propre domaine ──────────────────────
// FRONTEND_URL doit être défini dans les variables d'env Render
// (ex: https://chessbet-y4ay.onrender.com). En dev local, fallback sur '*'.
const ALLOWED_ORIGINS = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL]
  : '*';

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET','POST'] }
});

// ── Middleware ──────────────────────────────────────────────
app.use(helmet()); // CSP par défaut réactivée
app.use(cors({ origin: ALLOWED_ORIGINS }));

// ── Rate limiting — anti brute-force / anti-spam ─────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,                  // 20 tentatives par IP / 15min
  message: { error: 'Trop de tentatives, réessaie dans quelques minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 10,
  message: { error: 'Trop de requêtes, ralentis un peu.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const globalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // 120 req/min/IP toutes routes API confondues
  message: { error: 'Trop de requêtes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/payments',      paymentLimiter);
app.use('/api', globalApiLimiter);

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

// ── Anti-spam sockets — limite les actions sensibles par joueur ──
// Évite qu'un client triché spamme find_match/create_game pour saturer la DB
const socketActionLog = new Map(); // uid -> [timestamps]
const SOCKET_ACTION_WINDOW_MS = 10 * 1000; // 10s
const SOCKET_ACTION_MAX       = 8;         // 8 actions / 10s

function isSocketRateLimited(uid) {
  const now = Date.now();
  const log = (socketActionLog.get(uid) || []).filter(t => now - t < SOCKET_ACTION_WINDOW_MS);
  log.push(now);
  socketActionLog.set(uid, log);
  return log.length > SOCKET_ACTION_MAX;
}

// Nettoyage périodique pour éviter une fuite mémoire sur le long terme
setInterval(() => {
  const now = Date.now();
  for (const [uid, log] of socketActionLog.entries()) {
    const fresh = log.filter(t => now - t < SOCKET_ACTION_WINDOW_MS);
    if (fresh.length === 0) socketActionLog.delete(uid);
    else socketActionLog.set(uid, fresh);
  }
}, 60 * 1000);

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
    if (isSocketRateLimited(uid)) return socket.emit('error', 'Trop de requêtes, patiente quelques secondes.');
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
    if (isSocketRateLimited(uid)) return socket.emit('match_error', 'Trop de requêtes, patiente quelques secondes.');
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
    if (isSocketRateLimited(uid)) return socket.emit('error', 'Trop de requêtes, patiente quelques secondes.');
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

  // Recevoir un coup
  socket.on('move', ({ gameId, move }) => {
    const game = games.get(gameId);
    if (!game || game.finished) return;
    const isWhite = game.players.white === uid;
    const isBlack = game.players.black === uid;
    if (!isWhite && !isBlack) return;
    if ((game.turn === 'w' && !isWhite) || (game.turn === 'b' && !isBlack)) return;

    // Mettre à jour le timer du joueur qui vient de jouer
    const now = Date.now();
    if (game.lastTick) {
      const elapsed = Math.floor((now - game.lastTick) / 1000);
      game.timers[game.turn] = Math.max(0, game.timers[game.turn] - elapsed);
    }
    game.lastTick = now;
    game.turn = game.turn === 'w' ? 'b' : 'w';
    game.moveHistory.push(move);

    io.to(gameId).emit('move', { move, turn: game.turn, timers: game.timers });
  });

  // Fin de partie signalée par le client (mat, pat, nulle, etc.)
  socket.on('game_over', ({ gameId, result, reason }) => {
    const game = games.get(gameId);
    if (!game || game.finished) return;
    game.finished = true;
    clearGameTimer(gameId);
    settle(gameId, game, result, reason);
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
    game.finished = true;
    clearGameTimer(gameId);
    const result = game.players.white === uid ? 'black' : 'white';
    io.to(gameId).emit('game_over', { result, reason: 'resign' });
    settle(gameId, game, result, 'resign');
  });

  // Offrir la nulle
  socket.on('offer_draw', ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.finished) return;
    // Notifier l'adversaire
    socket.to(gameId).emit('draw_offered', { from: uname });
  });

  // Accepter la nulle
  socket.on('accept_draw', ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.finished) return;
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
      if (game.players.white) await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [refund, game.players.white]);
      if (game.players.black) await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [refund, game.players.black]);
    } else {
      const winnerId = result === 'white' ? game.players.white : game.players.black;
      await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [winnerGain, winnerId]);
      await client.query('UPDATE games SET finished=true,result=$1,reason=$2,commission=$3,winner_id=$4 WHERE id=$5',
        [result, reason, commission, winnerId, gameId]);
    }

    await client.query('UPDATE admin_stats SET total_commission=total_commission+$1, total_volume=total_volume+$2, total_games=total_games+1 WHERE id=1',
      [commission, pot]);

    await client.query('INSERT INTO transactions(user_id,type,amount,status) VALUES($1,$2,$3,$4)',
      [result === 'white' ? game.players.white : game.players.black, 'commission', commission, 'completed']);

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

initDB().then(() => {
  server.listen(PORT, () => console.log(`✅ ChessBet sur http://localhost:${PORT}`));
}).catch(e => { console.error('Erreur DB:', e); process.exit(1); });
