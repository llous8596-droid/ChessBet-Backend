const jwt = require('jsonwebtoken');
const { pool } = require('../db');

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer '))
    return res.status(401).json({ error: 'Non authentifié' });
  try {
    req.user = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

// À utiliser après `auth` : vérifie que l'utilisateur est admin
async function isAdmin(req, res, next) {
  try {
    const r = await pool.query('SELECT is_admin FROM users WHERE id=$1', [req.user.id]);
    if (!r.rows.length || !r.rows[0].is_admin)
      return res.status(403).json({ error: 'Accès refusé' });
    next();
  } catch {
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

module.exports = { auth, isAdmin };
