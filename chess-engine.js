// ============================================================
// Moteur d'échecs côté SERVEUR — source de vérité.
// Port fidèle de la logique client (public/index.html) en CommonJS,
// utilisé pour valider chaque coup et déterminer la fin de partie
// sans jamais faire confiance au client.
// ============================================================

function isW(p) { return p && p === p.toUpperCase(); }
function colorOf(p) { return isW(p) ? 'w' : 'b'; }

function initialBoard() {
  return [
    ['r','n','b','q','k','b','n','r'],
    ['p','p','p','p','p','p','p','p'],
    [null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null],
    ['P','P','P','P','P','P','P','P'],
    ['R','N','B','Q','K','B','N','R'],
  ];
}

function cloneBoard(b) { return b.map(r => [...r]); }

function pseudoMoves(board, r, c, epSq, cR) {
  const piece = board[r][c]; if (!piece) return [];
  const p = piece.toLowerCase(), col = colorOf(piece), opp = col === 'w' ? 'b' : 'w', ms = [];
  const inB = (r, c) => r >= 0 && r <= 7 && c >= 0 && c <= 7;
  const free = (r, c) => inB(r, c) && !board[r][c];
  const canLand = (r, c) => inB(r, c) && (!board[r][c] || colorOf(board[r][c]) === opp);

  if (p === 'p') {
    const d = col === 'w' ? -1 : 1, start = col === 'w' ? 6 : 1;
    if (free(r + d, c)) { ms.push([r + d, c, 'pawn']); if (r === start && free(r + 2 * d, c)) ms.push([r + 2 * d, c, 'pawn2']); }
    for (const dc of [-1, 1]) {
      if (inB(r + d, c + dc) && board[r + d]?.[c + dc] && colorOf(board[r + d][c + dc]) === opp) ms.push([r + d, c + dc, 'cap']);
      if (epSq && epSq[0] === r + d && epSq[1] === c + dc) ms.push([r + d, c + dc, 'ep']);
    }
  }
  if (p === 'n') { for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) if (canLand(r + dr, c + dc)) ms.push([r + dr, c + dc, 'n']); }
  const slide = (dirs) => { for (const [dr, dc] of dirs) { let i = 1; while (true) { const nr = r + dr * i, nc = c + dc * i; if (!inB(nr, nc)) break; if (board[nr][nc]) { if (colorOf(board[nr][nc]) === opp) ms.push([nr, nc, 'cap']); break; } ms.push([nr, nc, 'slide']); i++; } } };
  if (p === 'r' || p === 'q') slide([[0,1],[0,-1],[1,0],[-1,0]]);
  if (p === 'b' || p === 'q') slide([[1,1],[1,-1],[-1,1],[-1,-1]]);
  if (p === 'k') {
    for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) if (canLand(r + dr, c + dc)) ms.push([r + dr, c + dc, 'k']);
    if (cR) {
      const row = col === 'w' ? 7 : 0;
      if (r === row && c === 4) {
        const KS = col === 'w' ? cR.wK : cR.bK, QS = col === 'w' ? cR.wQ : cR.bQ, KP = col === 'w' ? 'R' : 'r', QP = col === 'w' ? 'R' : 'r';
        if (KS && !board[row][5] && !board[row][6] && board[row][7] === KP) ms.push([row, 6, 'ck']);
        if (QS && !board[row][3] && !board[row][2] && !board[row][1] && board[row][0] === QP) ms.push([row, 2, 'cq']);
      }
    }
  }
  return ms;
}

function applyMove(board, fr, fc, tr, tc, flag, promo) {
  const b = cloneBoard(board), piece = b[fr][fc], col = colorOf(piece);
  b[tr][tc] = piece; b[fr][fc] = null;
  if (flag === 'ep') { b[col === 'w' ? tr + 1 : tr - 1][tc] = null; }
  if (flag === 'ck') { const row = col === 'w' ? 7 : 0; b[row][5] = b[row][7]; b[row][7] = null; }
  if (flag === 'cq') { const row = col === 'w' ? 7 : 0; b[row][3] = b[row][0]; b[row][0] = null; }
  if (piece === 'P' && tr === 0) b[tr][tc] = (promo && 'QRBN'.includes(promo.toUpperCase())) ? promo.toUpperCase() : 'Q';
  if (piece === 'p' && tr === 7) b[tr][tc] = (promo && 'qrbn'.includes(promo.toLowerCase())) ? promo.toLowerCase() : 'q';
  return b;
}

function isAttacked(board, r, c, byCol) {
  for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
    const p = board[rr][cc];
    if (p && colorOf(p) === byCol && pseudoMoves(board, rr, cc, null, null).some(([mr, mc]) => mr === r && mc === c)) return true;
  }
  return false;
}

function isInCheck(board, col) {
  const k = col === 'w' ? 'K' : 'k';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c] === k) return isAttacked(board, r, c, col === 'w' ? 'b' : 'w');
  return true;
}

function legalMoves(board, r, c, epSq, castleRights) {
  const piece = board[r][c]; if (!piece) return [];
  const col = colorOf(piece);
  return pseudoMoves(board, r, c, epSq, castleRights).filter(([tr, tc, flag]) => {
    if (flag === 'ck' || flag === 'cq') {
      if (isInCheck(board, col)) return false;
      const row = col === 'w' ? 7 : 0, opp = col === 'w' ? 'b' : 'w';
      const pass = flag === 'ck' ? [row, 5] : [row, 3];
      if (isAttacked(board, pass[0], pass[1], opp) || isAttacked(board, tr, tc, opp)) return false;
    }
    return !isInCheck(applyMove(board, r, c, tr, tc, flag), col);
  });
}

function hasAnyLegal(board, col, epSq, castleRights) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
    if (board[r][c] && colorOf(board[r][c]) === col && legalMoves(board, r, c, epSq, castleRights).length) return true;
  return false;
}

function serializePos(board, turn, castleRights, epSq) {
  let s = ''; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) s += board[r][c] || '.';
  s += turn + (castleRights.wK ? 'K' : '') + (castleRights.wQ ? 'Q' : '') + (castleRights.bK ? 'k' : '') + (castleRights.bQ ? 'q' : '');
  s += epSq ? `${epSq[0]}${epSq[1]}` : '--';
  return s;
}

function insufficientMaterial(board) {
  const ps = []; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const p = board[r][c]; if (p) ps.push(p.toLowerCase()); }
  if (ps.every(p => p === 'k')) return true;
  const nk = ps.filter(p => p !== 'k');
  if (nk.length === 1 && (nk[0] === 'n' || nk[0] === 'b')) return true;
  if (nk.length === 2 && nk.every(p => p === 'b')) return true;
  return false;
}

// ── État de partie complet géré par le serveur ──────────────
function newGameState() {
  return {
    board: initialBoard(),
    turn: 'w',
    castleRights: { wK: true, wQ: true, bK: true, bQ: true },
    epSq: null,
    halfMoveClock: 0,
    positionHistory: [],
  };
}

// Valide et applique un coup envoyé par le client.
// Retourne { ok:true, state, flag, promo, isCapture } ou { ok:false, error }.
function tryApplyMove(state, color, fr, fc, tr, tc, promo) {
  if (![fr, fc, tr, tc].every(n => Number.isInteger(n) && n >= 0 && n <= 7))
    return { ok: false, error: 'Coup invalide (hors plateau)' };
  if (state.turn !== color) return { ok: false, error: 'Pas votre tour' };

  const piece = state.board[fr][fc];
  if (!piece) return { ok: false, error: 'Aucune pièce sur la case de départ' };
  if (colorOf(piece) !== color) return { ok: false, error: 'Ce n\'est pas votre pièce' };

  const moves = legalMoves(state.board, fr, fc, state.epSq, state.castleRights);
  const found = moves.find(([mr, mc]) => mr === tr && mc === tc);
  if (!found) return { ok: false, error: 'Coup illégal' };
  const flag = found[2];

  const isPawn = piece.toLowerCase() === 'p';
  const isCapture = !!(state.board[tr][tc] || flag === 'ep');

  const newBoard = applyMove(state.board, fr, fc, tr, tc, flag, promo);
  const newCastle = { ...state.castleRights };
  if (piece === 'K') { newCastle.wK = false; newCastle.wQ = false; }
  if (piece === 'k') { newCastle.bK = false; newCastle.bQ = false; }
  if (piece === 'R') { if (fc === 0) newCastle.wQ = false; if (fc === 7) newCastle.wK = false; }
  if (piece === 'r') { if (fc === 0) newCastle.bQ = false; if (fc === 7) newCastle.bK = false; }
  if (tr === 7 && tc === 0) newCastle.wQ = false; if (tr === 7 && tc === 7) newCastle.wK = false;
  if (tr === 0 && tc === 0) newCastle.bQ = false; if (tr === 0 && tc === 7) newCastle.bK = false;

  let newEp = null;
  if (isPawn && Math.abs(tr - fr) === 2) newEp = [(fr + tr) / 2, tc];

  const newTurn = state.turn === 'w' ? 'b' : 'w';
  const newHalfMove = (isPawn || isCapture) ? 0 : state.halfMoveClock + 1;
  const newPosHistory = [...state.positionHistory, serializePos(newBoard, newTurn, newCastle, newEp)];

  const newState = {
    board: newBoard,
    turn: newTurn,
    castleRights: newCastle,
    epSq: newEp,
    halfMoveClock: newHalfMove,
    positionHistory: newPosHistory,
  };

  return { ok: true, state: newState, flag, promo, isCapture };
}

// Détermine si la partie est terminée après le dernier coup joué.
// Retourne null si la partie continue, ou { result, reason } sinon.
// result ∈ 'white' | 'black' | 'draw' — celui qui VIENT DE JOUER a `state.turn` comme adversaire.
function checkGameEnd(state) {
  const sideToMove = state.turn; // le joueur qui doit jouer maintenant
  const inCheck = isInCheck(state.board, sideToMove);
  const hasMoves = hasAnyLegal(state.board, sideToMove, state.epSq, state.castleRights);

  if (!hasMoves) {
    if (inCheck) {
      const winner = sideToMove === 'w' ? 'black' : 'white';
      return { result: winner, reason: 'checkmate' };
    }
    return { result: 'draw', reason: 'pat' };
  }
  if (state.halfMoveClock >= 100) return { result: 'draw', reason: 'Règle des 50 coups' };
  const lastPos = state.positionHistory[state.positionHistory.length - 1];
  if (state.positionHistory.filter(p => p === lastPos).length >= 3) return { result: 'draw', reason: 'Répétition triple' };
  if (insufficientMaterial(state.board)) return { result: 'draw', reason: 'Matériel insuffisant' };
  return null;
}

module.exports = { newGameState, tryApplyMove, checkGameEnd, isInCheck, colorOf };
