const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');

function makeToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// Inscription
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min)' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      'INSERT INTO users(username,email,password) VALUES($1,$2,$3) RETURNING id,username,email,balance',
      [username.trim(), email.toLowerCase().trim(), hash]
    );
    const user = r.rows[0];
    res.json({ token: makeToken(user), user: { id: user.id, username: user.username, balance: 0 } });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email ou pseudo déjà utilisé' });
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Connexion
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    if (!r.rows.length) return res.status(401).json({ error: 'Identifiants incorrects' });
    const user = r.rows[0];
    if (!await bcrypt.compare(password, user.password))
      return res.status(401).json({ error: 'Identifiants incorrects' });
    res.json({ token: makeToken(user), user: { id: user.id, username: user.username, balance: user.balance, is_admin: user.is_admin } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Profil
router.get('/me', auth, async (req, res) => {
  const r = await pool.query('SELECT id,username,email,balance,is_admin,created_at FROM users WHERE id=$1', [req.user.id]);
  res.json(r.rows[0]);
});

module.exports = router;
