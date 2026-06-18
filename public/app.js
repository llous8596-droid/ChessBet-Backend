// ============================================================
//  ÉTAT GLOBAL
// ============================================================
let token    = localStorage.getItem('cb_token') || null;
let me       = JSON.parse(localStorage.getItem('cb_user') || 'null');
let balance  = me?.balance || 0;
let socket   = null;

// État partie
let myColor      = null; // 'w' | 'b'
let currentGameId= null;
let gameStarted  = false;
let waitingGame  = false;

// Timers UI
let timerInterval = null;
let timers = { w: 300, b: 300 };
let myTurn = false;

const COMM = 0.05;
const DEP_FEE_PCT   = 1.5;   // doit correspondre à DEPOSIT_FEE_PERCENT côté serveur
const DEP_FEE_FIXED = 0.25;  // doit correspondre à DEPOSIT_FEE_FIXED_CENTS/100 côté serveur

function depositChargeAmount(creditAmount) {
  const charge = (creditAmount + DEP_FEE_FIXED) / (1 - DEP_FEE_PCT / 100);
  return Math.ceil(charge * 100) / 100;
}

// ============================================================
//  INIT
// ============================================================
window.onload = async () => {
  if (token && me) {
    initSocket();
    showLoggedIn();
    // Rafraîchir le statut admin depuis le serveur
    const fresh = await api('/api/auth/me', 'GET');
    if (fresh && !fresh.error) {
      me.is_admin = fresh.is_admin;
      me.balance  = fresh.balance;
      localStorage.setItem('cb_user', JSON.stringify(me));
      showLoggedIn();
    }
    const savedGame = localStorage.getItem('cb_current_game');
    if (savedGame) {
      currentGameId = savedGame;
      initBoard();
      showPage('game');
      showWaiting(false);
      setStatus('Reconnexion à la partie...', '');
      socket.emit('reconnect_game', { gameId: savedGame });
    } else {
      showPage('lobby');
    }
    loadAdminStats();
  } else {
    document.getElementById('page-auth').classList.add('active');
  }
};

// ============================================================
//  AUTH
// ============================================================
function switchTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t,i) => t.classList.toggle('active', (i===0&&tab==='login')||(i===1&&tab==='register')));
  document.getElementById('form-login').style.display    = tab==='login'    ? '' : 'none';
  document.getElementById('form-register').style.display = tab==='register' ? '' : 'none';
  document.getElementById('auth-error').style.display    = 'none';
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  const r = await api('/api/auth/login', 'POST', { email, password: pass });
  if (r.error) return showAuthError(r.error);
  saveSession(r.token, r.user);
  initSocket();
  showLoggedIn();
  showPage('lobby');
}

async function doRegister() {
  const username = document.getElementById('reg-username').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const pass     = document.getElementById('reg-pass').value;
  const r = await api('/api/auth/register', 'POST', { username, email, password: pass });
  if (r.error) return showAuthError(r.error);
  saveSession(r.token, r.user);
  initSocket();
  showLoggedIn();
  showPage('lobby');
}

function saveSession(t, user) {
  token = t; me = user; balance = user.balance;
  localStorage.setItem('cb_token', t);
  localStorage.setItem('cb_user', JSON.stringify(user));
}

function showLoggedIn() {
  document.getElementById('nav').style.display = 'flex';
  document.getElementById('nav-username').textContent = me.username;
  document.getElementById('nav-admin-btn').style.display = me.is_admin ? '' : 'none';
  updateBalanceUI();
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function logout() {
  localStorage.removeItem('cb_token');
  localStorage.removeItem('cb_user');
  if (socket) socket.disconnect();
  location.reload();
}

// ============================================================
//  SOCKET.IO
// ============================================================
function initSocket() {
  socket = io({ auth: { token } });

  socket.on('connect', () => {
    console.log('✅ Socket connecté');
    updateMMPreview();
  });
  socket.on('connect_error', e => console.error('Socket erreur:', e.message));

  // Matchmaking
  initMatchmakingListeners();

  // Lobby en temps réel
  socket.on('lobby_update', renderLobbyGames);
  socket.on('waiting_opponent', () => showWaiting(true));

  // Partie démarre
  socket.on('game_start', ({ gameId: gId, white, black, bet, pot, timeControl }) => {
    // Cas matchmaking : currentGameId pas encore set, board pas initialisé
    const isMatchmaking = !currentGameId;
    if (gId) {
      currentGameId = gId;
      currentPot    = pot;
    }

    showWaiting(false);
    gameStarted = true;
    gameActive  = true;
    waitingGame = false;
    timers.w = timeControl; timers.b = timeControl;
    localStorage.setItem('cb_current_game', currentGameId);

    // Pour le matchmaking : initialiser le board et naviguer vers la page jeu
    if (isMatchmaking) {
      initBoard();
      showPage('game');
    }

    const betEur  = bet / 100;
    const potEur  = pot / 100;
    const commEur = Math.round(potEur * COMM * 100) / 100;
    const gainEur = potEur - commEur;

    document.getElementById('game-title').textContent = `${white} ♔ vs ♚ ${black}`;
    document.getElementById('game-sub').textContent   = `Mise : € ${betEur} — Pot : € ${potEur} — Commission : € ${commEur}`;
    document.getElementById('pot-display').textContent = `€ ${potEur}`;
    document.getElementById('gain-display').textContent= `€ ${gainEur}`;
    document.getElementById('comm-display').textContent= `€ ${commEur}`;

    const iAmWhite = myColor === 'w';
    document.getElementById('pname-top').textContent = iAmWhite ? black : white;
    document.getElementById('pname-bot').textContent = me.username;
    document.getElementById('av-top').textContent = iAmWhite ? 'N' : 'B';
    document.getElementById('av-bot').textContent = iAmWhite ? 'B' : 'N';
    document.getElementById('av-top').className = 'avatar ' + (iAmWhite ? 'av-b' : 'av-w');
    document.getElementById('av-bot').className = 'avatar ' + (iAmWhite ? 'av-w' : 'av-b');
    document.getElementById('pbet-top').textContent = `Mise : € ${betEur}`;
    document.getElementById('pbet-bot').textContent = `Mise : € ${betEur}`;
    document.getElementById('timer-top-label').textContent = iAmWhite ? 'NOIRS' : 'BLANCS';
    document.getElementById('timer-bot-label').textContent = iAmWhite ? 'BLANCS' : 'NOIRS';

    updateTimerUI('w'); // blancs commencent
    startLocalTimer();
    setStatus(iAmWhite ? 'Tour des Blancs ♔ — À vous !' : 'Tour des Blancs ♔ — En attente...', '');
  });

  // Coup reçu
  socket.on('move', ({ move, turn, timers: t }) => {
    timers = t;
    applyRemoteMove(move);
    updateTimerUI(turn);
    checkDrawAfterMove();
  });

  // Fin de partie
  socket.on('game_over', ({ result, reason }) => {
    stopLocalTimer();
    gameActive = false;
    // settled vient juste après
  });

  socket.on('settled', ({ result, reason, winnerGain, commission }) => {
    stopLocalTimer();
    localStorage.removeItem('cb_current_game');
    const pot = currentPot || 0; // en centimes
    const iWin = (result === 'white' && myColor === 'w') || (result === 'black' && myColor === 'b');
    const isDraw = result === 'draw';
    const refundCents = Math.round((pot / 2) - (commission / 2));

    if (iWin) balance += winnerGain;
    if (isDraw) balance += refundCents;
    updateBalanceUI();

    const eur = c => `€ ${(c / 100).toFixed(2)}`;

    document.getElementById('result-title').textContent = isDraw ? '½ NULLE' : iWin ? '♛ VICTOIRE !' : '♟ DÉFAITE';
    document.getElementById('result-msg').textContent   = isDraw ? `Nulle — ${reason}` : iWin ? `Félicitations ! Vous avez gagné.` : `${result === 'white' ? 'Les Blancs' : 'Les Noirs'} gagnent (${reason}).`;
    document.getElementById('r-pot').textContent  = eur(pot);

    const gainRow = document.querySelector('.payout-win');
    const gainLabel = gainRow.querySelector('span:first-child');
    gainRow.classList.toggle('loss', !isDraw && !iWin);
    if (isDraw) {
      gainLabel.textContent = 'Remboursement';
      document.getElementById('r-gain').textContent = `${eur(refundCents)} (50% du pot − commission)`;
    } else if (iWin) {
      gainLabel.textContent = 'Votre gain';
      document.getElementById('r-gain').textContent = eur(winnerGain);
    } else {
      gainLabel.textContent = 'Votre perte';
      document.getElementById('r-gain').textContent = `− ${eur(pot / 2)}`;
    }
    document.getElementById('r-comm').textContent = isDraw || iWin ? eur(commission) : '—';
    document.getElementById('result-overlay').classList.add('show');
  });

  // Nulle proposée par adversaire
  socket.on('draw_offered', ({ from }) => {
    document.getElementById('draw-banner').classList.add('show');
  });

  socket.on('color_assigned', (color) => {
    if (color !== 'spectator') {
      myColor = color;
      if (searching) stopSearching(); // match trouvé via matchmaking
    }
  });

  // Mise à jour du solde confirmée par le serveur (débit/remboursement)
  socket.on('balance_update', ({ delta }) => {
    balance += delta;
    if (balance < 0) balance = 0;
    updateBalanceUI();
  });

  // Erreur générale (mise invalide, solde insuffisant, partie introuvable...)
  socket.on('error', (msg) => {
    showToast(typeof msg === 'string' ? msg : 'Erreur');
    if (!gameStarted) {
      currentGameId = null; waitingGame = false;
      localStorage.removeItem('cb_current_game');
      resetGame();
      showPage('lobby');
    }
  });

  // Partie annulée (créateur a quitté avant qu'un adversaire ne rejoigne)
  socket.on('game_cancelled', () => {
    currentGameId = null; waitingGame = false;
    localStorage.removeItem('cb_current_game');
    resetGame();
    showPage('lobby');
  });

  // Reconnexion réussie après rechargement de page
  socket.on('reconnect_state', ({ color, white, black, bet, pot, timeControl, turn, timers: t, moveHistory }) => {
    myColor = color;
    gameStarted = true;
    gameActive  = true;
    waitingGame = false;
    timers = t;

    const betEur = bet / 100;
    const potEur = pot / 100;
    const commEur = Math.round(potEur * COMM * 100) / 100;
    const gainEur = potEur - commEur;
    currentPot = pot;

    document.getElementById('game-title').textContent = `${white} ♔ vs ♚ ${black}`;
    document.getElementById('game-sub').textContent   = `Mise : € ${betEur} — Pot : € ${potEur} — Commission : € ${commEur}`;
    document.getElementById('pot-display').textContent = `€ ${potEur}`;
    document.getElementById('gain-display').textContent= `€ ${gainEur}`;
    document.getElementById('comm-display').textContent= `€ ${commEur}`;

    const iAmWhite = myColor === 'w';
    document.getElementById('pname-top').textContent = iAmWhite ? black : white;
    document.getElementById('pname-bot').textContent = me.username;
    document.getElementById('av-top').textContent = iAmWhite ? 'N' : 'B';
    document.getElementById('av-bot').textContent = iAmWhite ? 'B' : 'N';
    document.getElementById('av-top').className = 'avatar ' + (iAmWhite ? 'av-b' : 'av-w');
    document.getElementById('av-bot').className = 'avatar ' + (iAmWhite ? 'av-w' : 'av-b');
    document.getElementById('pbet-top').textContent = `Mise : € ${betEur}`;
    document.getElementById('pbet-bot').textContent = `Mise : € ${betEur}`;
    document.getElementById('timer-top-label').textContent = iAmWhite ? 'NOIRS' : 'BLANCS';
    document.getElementById('timer-bot-label').textContent = iAmWhite ? 'BLANCS' : 'NOIRS';

    // Rejouer les coups depuis le début pour reconstruire le plateau
    initBoard();
    for (const move of moveHistory) {
      applyRemoteMove(move);
    }
    currentTurn = turn;
    inCheck = isInCheck(G, currentTurn);
    renderBoard();
    renderMoves();

    updateTimerUI(turn);
    startLocalTimer();
  });

  socket.on('reconnect_failed', () => {
    localStorage.removeItem('cb_current_game');
    resetGame();
    showPage('lobby');
    showToast('La partie n\'existe plus');
  });
}

// ============================================================
//  LOBBY
// ============================================================
function renderLobbyGames(games) {
  const tb = document.getElementById('lobby-tbody');
  document.getElementById('stat-actives').textContent = games.length;

  if (!games.length) {
    tb.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--muted);">Aucune partie disponible — Crée la première !</td></tr>`;
    return;
  }
  tb.innerHTML = games.map(g => {
    const bet  = g.bet / 100;
    const pot  = g.pot / 100;
    const gain = pot - Math.round(pot * COMM * 100) / 100;
    const mins = Math.floor(g.timeControl / 60);
    return `<tr>
      <td>${g.creator}</td>
      <td class="muted-txt">${mins} min</td>
      <td class="amt">€ ${bet}</td>
      <td style="font-family:monospace;">€ ${pot}</td>
      <td class="muted-txt">€ ${gain}</td>
      <td><span class="badge badge-wait">EN ATTENTE</span></td>
      <td><button class="btn btn-ghost btn-sm" data-act="joinGame" data-arg="${g.id}" data-arg2="${g.bet}">REJOINDRE</button></td>
    </tr>`;
  }).join('');
}

function updatePreview() {
  let bet = parseFloat(document.getElementById('create-bet').value);
  if (!Number.isFinite(bet) || bet < 5) bet = 5;
  if (bet > 5000) bet = 5000;
  bet = Math.round(bet * 100) / 100;
  const pot  = bet * 2;
  const gain = (pot - pot * COMM).toFixed(2);
  document.getElementById('preview-txt').innerHTML = `Pot : <b>€ ${pot.toFixed(2)}</b> — Gain net si victoire : <b>€ ${gain}</b>`;
}

// ============================================================
//  MATCHMAKING
// ============================================================
let selectedBet = 500;
let selectedTC  = 300;
let searching   = false;
let searchTimer = null;
let searchSecs  = 0;
const TC_NAMES = {60:'Bullet 1+0',180:'Blitz 3+0',300:'Blitz 5+0',600:'Rapide 10+0',1800:'Classique 30+0'};

function selectBet(el,val){
  document.querySelectorAll('.bet-opt').forEach(b=>b.classList.remove('active'));
  el.classList.add('active'); selectedBet=val; updateMMPreview();
}
function selectTC(el,val){
  document.querySelectorAll('.tc-opt').forEach(b=>b.classList.remove('active'));
  el.classList.add('active'); selectedTC=val; updateMMPreview();
}
function updateMMPreview(){
  const pot=(selectedBet*2/100).toFixed(2);
  const gain=(selectedBet*2/100*0.95).toFixed(2);
  const pe=document.getElementById('mm-pot'); if(pe)pe.textContent='\u20ac '+pot;
  const ge=document.getElementById('mm-gain'); if(ge)ge.textContent='\u20ac '+gain;
}
function findMatch(){
  if(searching)return;
  if(selectedBet>balance)return openDepositModal();
  searching=true; searchSecs=0;
  document.getElementById('searching-box').style.display='';
  const fb=document.getElementById('find-btn');
  fb.disabled=true; fb.textContent='\u23f3 Recherche...';
  document.getElementById('search-bet-label').textContent='\u20ac '+selectedBet/100;
  document.getElementById('search-tc-label').textContent=TC_NAMES[selectedTC]||'';
  searchTimer=setInterval(()=>{
    searchSecs++;
    const el=document.getElementById('search-timer-txt');
    if(el)el.textContent=searchSecs+'s';
  },1000);
  socket.emit('find_match',{bet:selectedBet,timeControl:selectedTC});
}
function cancelMatch(){
  socket.emit('cancel_match');
  stopSearching();
}
function stopSearching(){
  searching=false; clearInterval(searchTimer); searchTimer=null;
  const sb=document.getElementById('searching-box');
  const fb=document.getElementById('find-btn');
  if(sb)sb.style.display='none';
  if(fb){fb.disabled=false;fb.textContent='🔍 CHERCHER UNE PARTIE';}
}
function initMatchmakingListeners(){
  socket.on('match_cancelled',()=>{stopSearching();showToast('Recherche annulee');});
  socket.on('match_error',(msg)=>{stopSearching();showToast('\u274c '+msg);});
  socket.on('queue_counts',(counts)=>{
    const key=selectedTC+'_'+selectedBet;
    const count=counts[key]||0;
    const el=document.getElementById('mm-queue-count');
    if(el)el.textContent=count;
  });
  // color_assigned gere dans initSocket
}

function openCreateModal() {
  updatePreview();
  document.getElementById('create-overlay').style.display = 'flex';
}
function closeCreateModal() {
  document.getElementById('create-overlay').style.display = 'none';
}
function confirmCreateGame() {
  closeCreateModal();
  createGame();
}

async function createGame() {
  const bet   = parseFloat(document.getElementById('create-bet').value);
  const time  = parseInt(document.getElementById('create-time').value);
  let   color = document.getElementById('create-color').value;
  if (color === 'rand') color = Math.random() < .5 ? 'w' : 'b';

  if (!Number.isFinite(bet) || bet < 5)    return showToast('Mise minimum : € 5');
  if (bet > 5000)                          return showToast('Mise maximum : € 5000');

  const betCents = Math.round(bet * 100);
  if (betCents > balance) return openDepositModal();

  const gameId = crypto.randomUUID();
  currentGameId  = gameId;
  currentPot     = betCents * 2;
  myColor        = color;
  gameActive     = false;
  waitingGame    = true;

  initBoard();
  showPage('game');
  showWaiting(true);
  setStatus('En attente d\'un adversaire...', '');

  socket.emit('create_game', { gameId, bet: betCents, timeControl: time, color });
}

async function joinGame(gameId, bet) {
  if (bet > balance) return openDepositModal();

  currentGameId = gameId;
  currentPot    = bet * 2;
  waitingGame   = false;
  gameActive    = false;

  initBoard();
  showPage('game');
  showWaiting(false);

  socket.emit('join_game', { gameId });
}

function cancelGame() {
  if (currentGameId) socket.emit('cancel_game', { gameId: currentGameId });
  currentGameId = null; waitingGame = false;
  localStorage.removeItem('cb_current_game');
  resetGame();
  showPage('lobby');
}

function leaveGame() {
  if (waitingGame && !gameActive) {
    cancelGame();
    return;
  }
  if (gameActive) {
    showConfirm('Quitter la partie ?', 'Compte comme un abandon.', () => {
      if (currentGameId) socket.emit('resign', { gameId: currentGameId });
      localStorage.removeItem('cb_current_game');
      resetGame();
      showPage('lobby');
    });
  } else {
    localStorage.removeItem('cb_current_game');
    resetGame(); showPage('lobby');
  }
}

function doResign() {
  if (!gameActive) return;
  showConfirm('Abandonner la partie ?', 'Tu perds ta mise.', () => {
    socket.emit('resign', { gameId: currentGameId });
  });
}

function offerDraw() {
  if (!gameActive) return;
  socket.emit('offer_draw', { gameId: currentGameId });
  showToast('Nulle proposée à l\'adversaire');
}

function acceptDraw() {
  document.getElementById('draw-banner').classList.remove('show');
  socket.emit('accept_draw', { gameId: currentGameId });
}

function declineDraw() {
  document.getElementById('draw-banner').classList.remove('show');
  showToast('Nulle refusée');
}

function resetGame() {
  gameActive = false; waitingGame = false;
  currentGameId = null; myColor = null; gameStarted = false;
  stopLocalTimer();
}

function closeResult() {
  document.getElementById('result-overlay').classList.remove('show');
  resetGame();
  showPage('lobby');
}

function showWaiting(show) {
  document.getElementById('waiting-overlay').style.display = show ? 'flex' : 'none';
}

// ============================================================
//  TIMER UI
// ============================================================
function fmtTime(s) {
  if (s <= 0) return '0:00';
  const m = Math.floor(s / 60), sc = s % 60;
  return `${m}:${sc < 10 ? '0' : ''}${sc}`;
}

let localTimerInterval = null;
let lastTickTime = null;

function startLocalTimer() {
  stopLocalTimer();
  lastTickTime = Date.now();
  localTimerInterval = setInterval(() => {
    if (!gameStarted) return;
    const now = Date.now();
    const elapsed = (now - lastTickTime) / 1000;
    lastTickTime = now;
    const activeTurn = currentTurn; // from chess engine
    timers[activeTurn] = Math.max(0, timers[activeTurn] - elapsed);
    document.getElementById(activeTurn === myColor ? 'timer-bot' : 'timer-top').textContent = fmtTime(Math.ceil(timers[activeTurn]));
    // Low time warning
    const box = activeTurn === myColor ? 'timer-bot-box' : 'timer-top-box';
    document.getElementById(box).classList.toggle('low', timers[activeTurn] < 10);
  }, 200);
}

function stopLocalTimer() {
  if (localTimerInterval) { clearInterval(localTimerInterval); localTimerInterval = null; }
}

function updateTimerUI(activeTurn) {
  const iAmTop = myColor !== activeTurn;
  document.getElementById('timer-top-box').classList.toggle('my-turn', iAmTop);
  document.getElementById('timer-bot-box').classList.toggle('my-turn', !iAmTop);
  document.getElementById('timer-top').textContent = fmtTime(Math.ceil(timers[myColor === 'w' ? 'b' : 'w']));
  document.getElementById('timer-bot').textContent = fmtTime(Math.ceil(timers[myColor]));
  // Turn dots
  const myIsActive = activeTurn === myColor;
  document.getElementById('turn-top').className = 'turn-dot ' + (myIsActive ? 'off' : 'on');
  document.getElementById('turn-bot').className = 'turn-dot ' + (myIsActive ? 'on'  : 'off');
  // Status
  if (gameActive) {
    if (inCheck) {
      const whoInCheck = currentTurn === 'w' ? 'Blancs' : 'Noirs';
      setStatus(`⚠ ÉCHEC — ${whoInCheck} !`, 's-check');
    } else {
      const txt = activeTurn === myColor ? 'À votre tour ♟' : 'Tour de l\'adversaire...';
      setStatus(txt, '');
    }
  }
}

function setStatus(msg, cls) {
  const sb = document.getElementById('status-bar');
  sb.textContent = msg;
  sb.className = 'status-bar ' + (cls || '');
}

// ============================================================
//  DÉPÔT
// ============================================================
const CURRENCY_SYMBOLS = { eur: '€', usd: '$', gbp: '£' };

function updateDepositPreview() {
  const amount   = parseFloat(document.getElementById('dep-amount').value) || 0;
  const currency = document.getElementById('dep-currency') ? document.getElementById('dep-currency').value : 'eur';
  const sym      = CURRENCY_SYMBOLS[currency] || '€';
  const charge   = depositChargeAmount(amount); // estimation approx (calcul exact fait côté serveur)
  const fee      = (charge - amount).toFixed(2);
  document.getElementById('dep-preview-txt').innerHTML =
    amount > 0 ? `Montant facturé : <b>${sym} ${charge.toFixed(2)}</b> (frais : ${sym} ${fee}) — crédité sur ton solde en euros` : '';
}

async function doDeposit() {
  const amount   = parseFloat(document.getElementById('dep-amount').value);
  const currency = document.getElementById('dep-currency') ? document.getElementById('dep-currency').value : 'eur';
  if (!amount || amount < 5) return showToast('Minimum 5');
  const r = await api('/api/payments/deposit', 'POST', { amount, currency });
  if (r.error) return showToast(r.error);
  window.location.href = r.url; // Redirige vers Stripe
}

async function doDepositModal() {
  const amount   = parseFloat(document.getElementById('dep-modal-amt').value);
  const currencyEl = document.getElementById('dep-modal-currency');
  const currency = currencyEl ? currencyEl.value : 'eur';
  if (!amount || amount < 5) return showToast('Minimum 5');
  const r = await api('/api/payments/deposit', 'POST', { amount, currency });
  if (r.error) return showToast(r.error);
  window.location.href = r.url;
}

function setDepAmount(amount) {
  document.getElementById('dep-amount').value = amount;
  updateDepositPreview();
}

function openDepositModal() {
  document.getElementById('dep-modal-bal').textContent = `€ ${(balance/100).toFixed(2)}`;
  document.getElementById('deposit-overlay').classList.add('show');
}
function closeDepositModal() { document.getElementById('deposit-overlay').classList.remove('show'); }

function updateBalanceUI() {
  const eur = (balance / 100).toFixed(2);
  document.getElementById('nav-balance').textContent = `€ ${eur}`;
}

// ============================================================
//  STATS PUBLIQUES (lobby)
// ============================================================
async function loadPublicStats() {
  const r = await api('/api/payments/stats', 'GET');
  if (r.total_commission !== undefined) {
    document.getElementById('stat-volume').textContent    = `€ ${((r.total_volume||0)/100).toLocaleString()}`;
    document.getElementById('stat-commission').textContent= `€ ${((r.total_commission||0)/100).toLocaleString()}`;
  }
}

// ============================================================
//  ADMIN
// ============================================================
async function loadAdminStats() {
  if (!me || !me.is_admin) return;
  const r = await api('/api/payments/admin', 'GET');
  if (r.error) return;
  if (r.total_commission !== undefined) {
    document.getElementById('kpi-games').textContent = r.total_games || 0;
    document.getElementById('kpi-vol').textContent   = `€ ${((r.total_volume||0)/100).toLocaleString()}`;
    document.getElementById('kpi-comm').textContent  = `€ ${((r.total_commission||0)/100).toLocaleString()}`;
    document.getElementById('kpi-users').textContent = r.total_users || 0;

    const available = ((r.total_commission||0) - (r.total_withdrawn_admin||0));
    const availEur  = (available/100).toFixed(2);
    document.getElementById('comm-total-val').textContent = `€ ${(r.total_commission/100).toLocaleString()} accumulées — € ${availEur} disponibles`;
    document.getElementById('admin-withdraw-max').textContent = `€ ${availEur}`;
    // Pré-remplir le montant avec le max disponible
    const amtInput = document.getElementById('admin-withdraw-amount');
    if (amtInput && !amtInput.value) amtInput.value = availEur;

    // Retraits joueurs récents (automatisés)
    const pw = document.getElementById('recent-withdrawals');
    const recent = r.recent_withdrawals || [];
    const statusLabel = { pending:'⏳ En cours', approved:'✅ Envoyé', paid:'✅ Reçu', failed:'❌ Échoué (remboursé)' };
    const statusColor = { pending:'var(--gold)', approved:'var(--green2)', paid:'var(--green2)', failed:'#e44' };
    if (!recent.length) {
      pw.innerHTML = '<div style="color:var(--muted);font-size:12px;">Aucun retrait</div>';
    } else {
      pw.innerHTML = recent.map(w => `
        <div style="display:flex;align-items:center;gap:1rem;padding:.8rem;background:var(--bg3);border-radius:6px;margin-bottom:.5rem;flex-wrap:wrap;">
          <div style="flex:1;min-width:120px;">
            <div style="font-size:12px;color:var(--muted);">${w.username}</div>
            <div style="font-family:monospace;color:var(--gold);font-size:1.1rem;">€ ${(w.amount/100).toFixed(2)}</div>
          </div>
          <div style="font-size:11px;color:var(--muted);">${new Date(w.created_at).toLocaleDateString('fr-FR')}</div>
          <div style="color:${statusColor[w.status]||'var(--muted)'};font-size:12px;">${statusLabel[w.status]||w.status}</div>
        </div>
      `).join('');
    }
  }
}

// ============================================================
//  WALLET — RETRAITS JOUEUR
// ============================================================
async function loadWallet() {
  // Solde
  document.getElementById('wallet-balance').textContent = `€ ${(balance/100).toFixed(2)}`;

  // Statut du compte de paiement Stripe Connect
  await refreshConnectStatus();

  // Bouton "Tout"
  document.getElementById('qb-all').onclick = () => {
    document.getElementById('withdraw-amount').value = (balance/100).toFixed(2);
  };

  // Historique retraits
  const hist = await api('/api/payments/withdrawals', 'GET');
  const tb = document.getElementById('withdraw-history');
  if (!hist.length) {
    tb.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:1.5rem;color:var(--muted);">Aucun retrait</td></tr>';
  } else {
    const statusLabel = { pending:'⏳ En cours', approved:'✅ Envoyé', paid:'✅ Reçu', failed:'❌ Échoué (remboursé)' };
    const statusColor = { pending:'var(--gold)', approved:'var(--green2)', paid:'var(--green2)', failed:'#e44' };
    tb.innerHTML = hist.map(w => `<tr>
      <td style="color:var(--muted);font-size:12px;">${new Date(w.created_at).toLocaleDateString('fr-FR')}</td>
      <td class="amt">€ ${(w.amount/100).toFixed(2)}</td>
      <td style="color:${statusColor[w.status]||'var(--muted)'};font-size:12px;">${statusLabel[w.status]||w.status}</td>
    </tr>`).join('');
  }
}

async function refreshConnectStatus() {
  const r = await api('/api/payments/connect/status', 'GET');
  const okEl = document.getElementById('connect-status-ok');
  const pendingEl = document.getElementById('connect-status-pending');
  const onboardBtn = document.getElementById('connect-onboard-btn');
  const withdrawBtn = document.getElementById('withdraw-btn');

  okEl.style.display = 'none';
  pendingEl.style.display = 'none';
  pendingEl.innerHTML = '⚠️ Configuration incomplète. Termine la configuration pour pouvoir retirer.';

  if (r.payouts_enabled) {
    okEl.style.display = 'block';
    onboardBtn.textContent = 'MODIFIER MES INFOS DE PAIEMENT';
    withdrawBtn.disabled = false;
    withdrawBtn.style.opacity = '1';
  } else {
    pendingEl.style.display = 'block';
    onboardBtn.textContent = r.configured ? 'TERMINER LA CONFIGURATION →' : 'CONFIGURER MES INFOS DE PAIEMENT →';
    withdrawBtn.disabled = true;
    withdrawBtn.style.opacity = '.5';

    let detail = '';
    if (r.currently_due?.length) {
      detail += `Informations manquantes : ${r.currently_due.join(', ')}. `;
    }
    if (r.pending_verification?.length) {
      detail += `En cours de vérification par Stripe : ${r.pending_verification.join(', ')}. Ça peut prendre quelques heures.`;
    }
    if (r.disabled_reason) {
      detail += ` (Raison : ${r.disabled_reason})`;
    }
    if (detail) {
      pendingEl.innerHTML = `⚠️ Configuration incomplète. ${detail}`;
    } else if (r.details_submitted) {
      pendingEl.innerHTML = `⚠️ Formulaire envoyé, en attente de validation par Stripe. Réessaie dans quelques minutes.`;
    }
  }
}

async function startConnectOnboarding() {
  const r = await api('/api/payments/connect/onboard', 'POST');
  if (r.error) return showToast('❌ ' + r.error);
  window.location.href = r.url; // Redirige vers Stripe (onboarding hébergé)
}

async function doWithdrawPlayer() {
  const amtInput = document.getElementById('withdraw-amount').value;
  const amount = parseFloat(amtInput);
  if (!Number.isFinite(amount) || amount < 10) return showToast('Minimum 10€');
  if (amount > 10000) return showToast('Maximum 10000€');
  if (Math.round(amount * 100) > balance) return showToast('Solde insuffisant');

  const withdrawBtn = document.getElementById('withdraw-btn');
  withdrawBtn.disabled = true;
  showToast('⏳ Traitement du retrait...');

  const r = await api('/api/payments/withdraw', 'POST', { amount });
  withdrawBtn.disabled = false;

  if (r.error) return showToast('❌ ' + r.error);

  // Le serveur a déjà débité/remboursé selon le résultat — on resynchronise depuis le serveur
  const me2 = await api('/api/auth/me', 'GET');
  if (!me2.error) { balance = me2.balance; updateBalanceUI(); }

  showToast('✓ ' + (r.message || 'Retrait envoyé'));
  loadWallet();
}

// ============================================================
//  ADMIN — RETRAIT DES COMMISSIONS (plateforme)
// ============================================================
async function doWithdraw() {
  const amtRaw  = document.getElementById('admin-withdraw-amount').value.trim();
  const amtEur  = parseFloat(amtRaw);
  const amtCents = amtEur > 0 ? Math.round(amtEur * 100) : null;

  const btn = document.querySelector('[data-act="doWithdraw"]');
  btn.disabled = true; btn.textContent = '⏳ En cours...';

  const r = await api('/api/payments/admin/withdraw', 'POST', {
    amount_cents: amtCents,
  });

  btn.disabled = false; btn.textContent = 'RETIRER →';

  if (r.error) return showToast('❌ ' + r.error);
  showToast('✅ ' + r.message);
  loadAdminStats();
}

// ============================================================
//  ADMIN — RETRAITS JOUEURS (lecture seule, automatisés via Stripe Connect)
// ============================================================

// ============================================================
//  NAV / PAGES
// ============================================================
function showPage(id) {
  if (id === 'admin' && (!me || !me.is_admin)) {
    showToast('Accès réservé aux administrateurs');
    id = 'lobby';
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  if (id === 'admin') loadAdminStats();
  if (id === 'wallet') loadWallet();
  if (id === 'lobby') { updatePreview(); updateDepositPreview(); loadPublicStats(); fetch('/api/lobby').then(r=>r.json()).then(renderLobbyGames); }
}

// ============================================================
//  API HELPER
// ============================================================
async function api(url, method, body) {
  try {
    const r = await fetch(url, {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await r.json();
  } catch { return { error: 'Erreur réseau' }; }
}

// ============================================================
//  CONFIRM MODAL
// ============================================================
let confirmCb = null;
function showConfirm(title, msg, cb) {
  confirmCb = cb;
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-msg').textContent   = msg;
  document.getElementById('confirm-ok').onclick = () => { closeConfirm(); cb(); };
  document.getElementById('confirm-overlay').classList.add('show');
}
function closeConfirm() { document.getElementById('confirm-overlay').classList.remove('show'); }

// ============================================================
//  TOAST
// ============================================================
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

// ============================================================
//  CHESS ENGINE (complet avec roque, prise en passant, clouage, nulles)
// ============================================================
let G = [], sel = null, currentTurn = 'w', gameActive = false;
let moveHistory = [], inCheck = false;
let castleRights = {wK:true,wQ:true,bK:true,bQ:true};
let enPassantSq = null, pendingPromo = null;
let halfMoveClock = 0, positionHistory = [];
let lastMove = null; // {fr,fc,tr,tc} pour highlight
let currentPot = 0;

const GLYPHS = {K:'♔',Q:'♕',R:'♖',B:'♗',N:'♘',P:'♙',k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'};

function isW(p){return p&&p===p.toUpperCase();}
function colorOf(p){return isW(p)?'w':'b';}

function initBoard(){
  G=[['r','n','b','q','k','b','n','r'],['p','p','p','p','p','p','p','p'],
     [null,null,null,null,null,null,null,null],[null,null,null,null,null,null,null,null],
     [null,null,null,null,null,null,null,null],[null,null,null,null,null,null,null,null],
     ['P','P','P','P','P','P','P','P'],['R','N','B','Q','K','B','N','R']];
  sel=null; currentTurn='w'; moveHistory=[]; inCheck=false;
  castleRights={wK:true,wQ:true,bK:true,bQ:true};
  enPassantSq=null; pendingPromo=null; halfMoveClock=0; positionHistory=[]; lastMove=null;
  renderBoard();
}

function cloneBoard(b){return b.map(r=>[...r]);}

function pseudoMoves(board,r,c,epSq,cR){
  const piece=board[r][c]; if(!piece)return[];
  const p=piece.toLowerCase(),col=colorOf(piece),opp=col==='w'?'b':'w',ms=[];
  const inB=(r,c)=>r>=0&&r<=7&&c>=0&&c<=7;
  const free=(r,c)=>inB(r,c)&&!board[r][c];
  const canLand=(r,c)=>inB(r,c)&&(!board[r][c]||colorOf(board[r][c])===opp);
  if(p==='p'){
    const d=col==='w'?-1:1,start=col==='w'?6:1;
    if(free(r+d,c)){ms.push([r+d,c,'pawn']);if(r===start&&free(r+2*d,c))ms.push([r+2*d,c,'pawn2']);}
    for(const dc of[-1,1]){
      if(inB(r+d,c+dc)&&board[r+d]?.[c+dc]&&colorOf(board[r+d][c+dc])===opp)ms.push([r+d,c+dc,'cap']);
      if(epSq&&epSq[0]===r+d&&epSq[1]===c+dc)ms.push([r+d,c+dc,'ep']);
    }
  }
  if(p==='n'){for(const[dr,dc]of[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])if(canLand(r+dr,c+dc))ms.push([r+dr,c+dc,'n']);}
  const slide=dirs=>{for(const[dr,dc]of dirs){let i=1;while(true){const nr=r+dr*i,nc=c+dc*i;if(!inB(nr,nc))break;if(board[nr][nc]){if(colorOf(board[nr][nc])===opp)ms.push([nr,nc,'cap']);break;}ms.push([nr,nc,'slide']);i++;}}};
  if(p==='r'||p==='q')slide([[0,1],[0,-1],[1,0],[-1,0]]);
  if(p==='b'||p==='q')slide([[1,1],[1,-1],[-1,1],[-1,-1]]);
  if(p==='k'){
    for(const[dr,dc]of[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]])if(canLand(r+dr,c+dc))ms.push([r+dr,c+dc,'k']);
    if(cR){
      const row=col==='w'?7:0;
      if(r===row&&c===4){
        const KS=col==='w'?cR.wK:cR.bK,QS=col==='w'?cR.wQ:cR.bQ,KP=col==='w'?'R':'r',QP=col==='w'?'R':'r';
        if(KS&&!board[row][5]&&!board[row][6]&&board[row][7]===KP)ms.push([row,6,'ck']);
        if(QS&&!board[row][3]&&!board[row][2]&&!board[row][1]&&board[row][0]===QP)ms.push([row,2,'cq']);
      }
    }
  }
  return ms;
}

function applyMove(board,fr,fc,tr,tc,flag,promo){
  const b=cloneBoard(board),piece=b[fr][fc],col=colorOf(piece);
  b[tr][tc]=piece; b[fr][fc]=null;
  if(flag==='ep'){b[col==='w'?tr+1:tr-1][tc]=null;}
  if(flag==='ck'){const row=col==='w'?7:0;b[row][5]=b[row][7];b[row][7]=null;}
  if(flag==='cq'){const row=col==='w'?7:0;b[row][3]=b[row][0];b[row][0]=null;}
  if(piece==='P'&&tr===0)b[tr][tc]=promo||'Q';
  if(piece==='p'&&tr===7)b[tr][tc]=promo||'q';
  return b;
}

function isAttacked(board,r,c,byCol){
  for(let rr=0;rr<8;rr++)for(let cc=0;cc<8;cc++){
    const p=board[rr][cc];
    if(p&&colorOf(p)===byCol&&pseudoMoves(board,rr,cc,null,null).some(([mr,mc])=>mr===r&&mc===c))return true;
  }
  return false;
}

function isInCheck(board,col){
  const k=col==='w'?'K':'k';
  for(let r=0;r<8;r++)for(let c=0;c<8;c++)if(board[r][c]===k)return isAttacked(board,r,c,col==='w'?'b':'w');
  return true;
}

function legalMoves(r,c){
  const piece=G[r][c]; if(!piece)return[];
  const col=colorOf(piece);
  return pseudoMoves(G,r,c,enPassantSq,castleRights).filter(([tr,tc,flag])=>{
    if(flag==='ck'||flag==='cq'){
      if(isInCheck(G,col))return false;
      const row=col==='w'?7:0,opp=col==='w'?'b':'w';
      const pass=flag==='ck'?[row,5]:[row,3];
      if(isAttacked(G,pass[0],pass[1],opp)||isAttacked(G,tr,tc,opp))return false;
    }
    return !isInCheck(applyMove(G,r,c,tr,tc,flag),col);
  });
}

function hasAnyLegal(col){
  for(let r=0;r<8;r++)for(let c=0;c<8;c++)
    if(G[r][c]&&colorOf(G[r][c])===col&&legalMoves(r,c).length)return true;
  return false;
}

function kingPos(col){const k=col==='w'?'K':'k';for(let r=0;r<8;r++)for(let c=0;c<8;c++)if(G[r][c]===k)return[r,c];return null;}

function serializePos(){
  let s='';for(let r=0;r<8;r++)for(let c=0;c<8;c++)s+=G[r][c]||'.';
  s+=currentTurn+(castleRights.wK?'K':'')+(castleRights.wQ?'Q':'')+(castleRights.bK?'k':'')+(castleRights.bQ?'q':'');
  s+=enPassantSq?`${enPassantSq[0]}${enPassantSq[1]}`:'--';
  return s;
}

function insufficientMaterial(){
  const ps=[];for(let r=0;r<8;r++)for(let c=0;c<8;c++){const p=G[r][c];if(p)ps.push(p.toLowerCase());}
  if(ps.every(p=>p==='k'))return true;
  const nk=ps.filter(p=>p!=='k');
  if(nk.length===1&&(nk[0]==='n'||nk[0]==='b'))return true;
  if(nk.length===2&&nk.every(p=>p==='b'))return true;
  return false;
}

function checkDraw(){
  if(halfMoveClock>=100)return 'Règle des 50 coups';
  const pos=serializePos();
  if(positionHistory.filter(p=>p===pos).length>=2)return 'Répétition triple';
  if(insufficientMaterial())return 'Matériel insuffisant';
  return null;
}

function pieceSVG(piece){
  const isWhite=piece===piece.toUpperCase();
  const fill=isWhite?'#ffffff':'#1a1a1a',stroke=isWhite?'#1a1a1a':'#ffffff',sw='1.5';
  const p=piece.toLowerCase();
  const shapes={
    k:`<circle cx="24" cy="14" r="4" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
       <rect x="20" y="10" width="8" height="2" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
       <polygon points="12,40 36,40 32,20 16,20" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>
       <rect x="10" y="38" width="28" height="4" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
    q:`<circle cx="24" cy="10" r="4" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
       <circle cx="10" cy="14" r="3" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
       <circle cx="38" cy="14" r="3" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
       <polygon points="10,38 38,38 34,18 24,26 14,18" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>
       <rect x="9" y="36" width="30" height="4" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
    r:`<rect x="12" y="8" width="24" height="8" rx="1" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
       <rect x="14" y="8" width="4" height="5" fill="${stroke}"/>
       <rect x="22" y="8" width="4" height="5" fill="${stroke}"/>
       <rect x="30" y="8" width="4" height="5" fill="${stroke}"/>
       <rect x="14" y="16" width="20" height="20" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
       <rect x="10" y="36" width="28" height="5" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
    b:`<circle cx="24" cy="10" r="4" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
       <ellipse cx="24" cy="28" rx="10" ry="16" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
       <line x1="14" y1="28" x2="34" y2="28" stroke="${stroke}" stroke-width="${sw}"/>
       <rect x="10" y="38" width="28" height="4" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
    n:`<ellipse cx="24" cy="12" rx="10" ry="8" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
       <path d="M14,12 Q10,24 14,36 L34,36 Q32,24 28,18 Q22,22 14,12Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>
       <circle cx="20" cy="10" r="2" fill="${stroke}"/>
       <rect x="10" y="34" width="28" height="5" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
    p:`<circle cx="24" cy="13" r="7" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
       <polygon points="16,38 32,38 29,22 19,22" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>
       <rect x="11" y="36" width="26" height="5" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="52" height="52">${shapes[p]}</svg>`;
}

function renderBoard(){
  const bd=document.getElementById('board'); if(!bd)return;
  bd.innerHTML='';
  const flip=myColor==='b';
  const moves=sel?legalMoves(sel[0],sel[1]):[];
  const mset=new Set(moves.map(([r,c])=>`${r},${c}`));
  const kp=inCheck?kingPos(currentTurn):null;

  for(let ri=0;ri<8;ri++){for(let ci=0;ci<8;ci++){
    const r=flip?7-ri:ri,c=flip?7-ci:ci;
    const sq=document.createElement('div');
    sq.className=`sq ${(r+c)%2===0?'light':'dark'}`;
    const piece=G[r][c];
    if(piece)sq.innerHTML=pieceSVG(piece);
    if(sel&&sel[0]===r&&sel[1]===c)sq.classList.add('selected');
    if(mset.has(`${r},${c}`)){sq.classList.add('possible');if(piece)sq.classList.add('has-piece');}
    if(kp&&kp[0]===r&&kp[1]===c)sq.classList.add('check-king');
    if(lastMove&&((lastMove.fr===r&&lastMove.fc===c)||(lastMove.tr===r&&lastMove.tc===c)))sq.classList.add('last-move');
    sq.addEventListener('click',()=>handleClick(r,c));
    bd.appendChild(sq);
  }}
  // Coords
  const ranks=document.getElementById('coord-rank');
  const files=document.getElementById('coord-file');
  if(ranks){ranks.innerHTML='';for(let i=0;i<8;i++){const s=document.createElement('span');s.textContent=flip?i+1:8-i;ranks.appendChild(s);}}
  if(files){files.innerHTML='';for(let i=0;i<8;i++){const s=document.createElement('span');s.textContent=flip?'hgfedcba'[i]:'abcdefgh'[i];files.appendChild(s);}}
}

function handleClick(r,c){
  if(!gameActive||pendingPromo||currentTurn!==myColor)return;
  const piece=G[r][c];
  if(sel){
    const moves=legalMoves(sel[0],sel[1]);
    const found=moves.find(([mr,mc])=>mr===r&&mc===c);
    if(found){
      const[,, flag]=found;
      const movePiece=G[sel[0]][sel[1]];
      if((movePiece==='P'&&r===0)||(movePiece==='p'&&r===7)){
        pendingPromo={fr:sel[0],fc:sel[1],tr:r,tc:c,flag};
        sel=null; renderBoard(); showPromoModal(colorOf(movePiece)); return;
      }
      commitMove(sel[0],sel[1],r,c,flag);
      sel=null; return;
    }
  }
  sel=(piece&&colorOf(piece)===currentTurn)?[r,c]:null;
  renderBoard();
}

function showPromoModal(col){
  const isW=col==='w';
  document.getElementById('pi-q').textContent=isW?'♕':'♛';
  document.getElementById('pi-r').textContent=isW?'♖':'♜';
  document.getElementById('pi-b').textContent=isW?'♗':'♝';
  document.getElementById('pi-n').textContent=isW?'♘':'♞';
  document.getElementById('promo-overlay').classList.add('show');
}

function doPromo(wP,bP){
  document.getElementById('promo-overlay').classList.remove('show');
  if(!pendingPromo)return;
  const{fr,fc,tr,tc,flag}=pendingPromo; pendingPromo=null;
  const promo=myColor==='w'?wP:bP;
  commitMove(fr,fc,tr,tc,flag,promo);
}

function commitMove(fr,fc,tr,tc,flag,promo){
  const piece=G[fr][fc];
  const isPawn=piece.toLowerCase()==='p';
  const isCapture=!!(G[tr][tc]||(flag==='ep'));
  if(isPawn||isCapture) halfMoveClock=0; else halfMoveClock++;

  G=applyMove(G,fr,fc,tr,tc,flag,promo);
  lastMove={fr,fc,tr,tc};

  // En passant
  enPassantSq=null;
  if(isPawn&&Math.abs(tr-fr)===2)enPassantSq=[(fr+tr)/2,tc];

  // Droits de roque
  if(piece==='K'){castleRights.wK=false;castleRights.wQ=false;}
  if(piece==='k'){castleRights.bK=false;castleRights.bQ=false;}
  if(piece==='R'){if(fc===0)castleRights.wQ=false;if(fc===7)castleRights.wK=false;}
  if(piece==='r'){if(fc===0)castleRights.bQ=false;if(fc===7)castleRights.bK=false;}
  if(tr===7&&tc===0)castleRights.wQ=false; if(tr===7&&tc===7)castleRights.wK=false;
  if(tr===0&&tc===0)castleRights.bQ=false; if(tr===0&&tc===7)castleRights.bK=false;

  // Notation
  const files='abcdefgh';
  let notation='';
  if(flag==='ck')notation='O-O';
  else if(flag==='cq')notation='O-O-O';
  else{
    const pL=piece.toUpperCase()==='P'?'':piece.toUpperCase();
    const cap=isCapture?'x':'';
    notation=`${pL}${files[fc]}${8-fr}${cap}${files[tc]}${8-tr}`;
    if(promo)notation+=`=${promo.toUpperCase()}`;
  }
  moveHistory.push({notation,turn:currentTurn});

  // Changer de tour
  currentTurn=currentTurn==='w'?'b':'w';
  positionHistory.push(serializePos());
  inCheck=isInCheck(G,currentTurn);

  renderBoard();
  renderMoves();

  // Envoyer au serveur
  const move={fr,fc,tr,tc,flag,promo,notation};
  if(socket&&currentGameId)socket.emit('move',{gameId:currentGameId,move});

  afterMove();
}

function applyRemoteMove({fr,fc,tr,tc,flag,promo}){
  const piece=G[fr][fc];
  if(!piece)return;
  const isPawn=piece.toLowerCase()==='p';
  const isCapture=!!(G[tr][tc]||(flag==='ep'));
  if(isPawn||isCapture) halfMoveClock=0; else halfMoveClock++;
  G=applyMove(G,fr,fc,tr,tc,flag,promo);
  lastMove={fr,fc,tr,tc};
  enPassantSq=null;
  if(isPawn&&Math.abs(tr-fr)===2)enPassantSq=[(fr+tr)/2,tc];
  if(piece==='K'){castleRights.wK=false;castleRights.wQ=false;}
  if(piece==='k'){castleRights.bK=false;castleRights.bQ=false;}
  currentTurn=currentTurn==='w'?'b':'w';
  positionHistory.push(serializePos());
  inCheck=isInCheck(G,currentTurn);
  renderBoard();
  renderMoves();
}

function checkDrawAfterMove(){
  const dr=checkDraw();
  if(dr){gameActive=false;stopLocalTimer();socket.emit('game_over',{gameId:currentGameId,result:'draw',reason:dr});}
  else afterMove();
}

function afterMove(){
  const noMoves=!hasAnyLegal(currentTurn);
  if(noMoves){
    gameActive=false; stopLocalTimer();
    if(inCheck){
      const winner=currentTurn==='w'?'black':'white';
      setStatus(`♛ ÉCHEC ET MAT !`,'s-mate');
      socket.emit('game_over',{gameId:currentGameId,result:winner,reason:'checkmate'});
    } else {
      setStatus('PAT — Nulle !','s-draw');
      socket.emit('game_over',{gameId:currentGameId,result:'draw',reason:'pat'});
    }
    return;
  }
  const dr=checkDraw();
  if(dr){
    gameActive=false; stopLocalTimer();
    setStatus(`½ Nulle — ${dr}`,'s-draw');
    socket.emit('game_over',{gameId:currentGameId,result:'draw',reason:dr});
    return;
  }
  if(inCheck){setStatus(`⚠ ÉCHEC !`,'s-check');}
}

function renderMoves(){
  const ml=document.getElementById('moves-list'); if(!ml)return;
  if(!moveHistory.length){ml.innerHTML='<span style="color:var(--muted);">La partie commence...</span>';return;}
  let html='';
  for(let i=0;i<moveHistory.length;i+=2){
    const wm=moveHistory[i],bm=moveHistory[i+1];
    html+=`<div class="move-pair"><span class="move-num">${Math.floor(i/2)+1}.</span><span class="move-txt">${wm.notation}</span>${bm?`<span class="move-txt">${bm.notation}</span>`:''}</div>`;
  }
  ml.innerHTML=html; ml.scrollTop=ml.scrollHeight;
}

// ============================================================
//  DÉLÉGATION D'ÉVÉNEMENTS (CSP strict : pas de gestionnaires inline)
//  Tous les boutons utilisent data-act / data-arg / data-arg2 / data-target
//  au lieu de onclick="..." pour respecter script-src-attr 'none'.
// ============================================================
function setFieldValue(target, value) {
  const el = document.getElementById(target);
  if (el) el.value = value;
}

function setCreateBetQuick(target, value) {
  setFieldValue(target, value);
  updatePreview();
}

const ACTIONS = {
  showPage:            (el, arg) => showPage(arg),
  openDepositModal:    () => openDepositModal(),
  closeDepositModal:   () => closeDepositModal(),
  logout:              () => logout(),
  switchTab:           (el, arg) => switchTab(arg),
  doLogin:             () => doLogin(),
  doRegister:          () => doRegister(),
  doDeposit:           () => doDeposit(),
  doDepositModal:      () => doDepositModal(),
  setDepAmount:        (el, arg) => setDepAmount(Number(arg)),
  selectBet:           (el, arg) => selectBet(el, Number(arg)),
  selectTC:            (el, arg) => selectTC(el, Number(arg)),
  findMatch:           () => findMatch(),
  cancelMatch:         () => cancelMatch(),
  openCreateModal:     () => openCreateModal(),
  closeCreateModal:    () => closeCreateModal(),
  confirmCreateGame:   () => confirmCreateGame(),
  leaveGame:           () => leaveGame(),
  cancelGame:          () => cancelGame(),
  acceptDraw:          () => acceptDraw(),
  declineDraw:         () => declineDraw(),
  offerDraw:           () => offerDraw(),
  doResign:            () => doResign(),
  startConnectOnboarding: () => startConnectOnboarding(),
  doWithdrawPlayer:    () => doWithdrawPlayer(),
  doWithdraw:          () => doWithdraw(),
  closeResult:         () => closeResult(),
  closeConfirm:        () => closeConfirm(),
  doPromo:             (el, arg, arg2) => doPromo(arg, arg2),
  joinGame:            (el, arg, arg2) => joinGame(arg, Number(arg2)),
  setFieldValue:       (el, arg, arg2, target) => setFieldValue(target, arg),
  setCreateBetQuick:   (el, arg, arg2, target) => setCreateBetQuick(target, arg),
  updateDepositPreview: () => updateDepositPreview(),
  updatePreview:        () => updatePreview(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el, el.dataset.arg, el.dataset.arg2, el.dataset.target);
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-oninput]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.oninput];
  if (fn) fn(el);
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-onchange]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.onchange];
  if (fn) fn(el);
});
