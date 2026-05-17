const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb, saveDb } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'greenloop-secret-change-in-prod';
const JWT_EXPIRES = '7d';

/**
 * POST /api/auth/register
 * Body: { name, phone, email?, password, role?, province?, farm_ha?, htx_code? }
 */
router.post('/register', async (req, res) => {
  try {
    const db = await getDb();
    const { name, phone, email, password, role = 'farmer', province, farm_ha = 0, htx_code } = req.body;

    if (!name || !phone || !password)
      return res.status(400).json({ error: 'name, phone, and password are required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!['farmer', 'htx', 'buyer', 'admin'].includes(role))
      return res.status(400).json({ error: 'Invalid role' });

    // Check duplicate
    const existing = db.exec(`SELECT id FROM users WHERE phone = '${phone}'`);
    if (existing.length && existing[0].values.length)
      return res.status(409).json({ error: 'Phone number already registered' });

    const id = uuidv4();
    const hash = await bcrypt.hash(password, 12);

    db.run(
      `INSERT INTO users (id,name,phone,email,password,role,province,farm_ha,htx_code,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, name, phone, email || null, hash, role, province || null, farm_ha, htx_code || null, new Date().toISOString()]
    );
    saveDb();

    const token = jwt.sign({ id, name, phone, role, province }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.status(201).json({ token, user: { id, name, phone, email, role, province, farm_ha } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/login
 * Body: { phone, password }
 */
router.post('/login', async (req, res) => {
  try {
    const db = await getDb();
    const { phone, password } = req.body;
    if (!phone || !password)
      return res.status(400).json({ error: 'phone and password required' });

    const result = db.exec(`SELECT * FROM users WHERE phone = '${phone}'`);
    if (!result.length || !result[0].values.length)
      return res.status(401).json({ error: 'Invalid credentials' });

    const cols = result[0].columns;
    const row = result[0].values[0];
    const user = Object.fromEntries(cols.map((c, i) => [c, row[i]]));

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // Update last_login
    db.run(`UPDATE users SET last_login = ? WHERE id = ?`, [new Date().toISOString(), user.id]);
    saveDb();

    const token = jwt.sign(
      { id: user.id, name: user.name, phone: user.phone, role: user.role, province: user.province },
      JWT_SECRET, { expiresIn: JWT_EXPIRES }
    );

    const { password: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/me — current user profile
 */
router.get('/me', auth, async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec(`SELECT id,name,phone,email,role,province,farm_ha,htx_code,created_at,last_login FROM users WHERE id = '${req.user.id}'`);
    if (!result.length || !result[0].values.length)
      return res.status(404).json({ error: 'User not found' });

    const cols = result[0].columns;
    const user = Object.fromEntries(cols.map((c, i) => [c, result[0].values[0][i]]));
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/auth/me — update profile
 */
router.put('/me', auth, async (req, res) => {
  try {
    const db = await getDb();
    const { name, email, province, farm_ha } = req.body;
    db.run(
      `UPDATE users SET name=COALESCE(?,name), email=COALESCE(?,email), province=COALESCE(?,province), farm_ha=COALESCE(?,farm_ha) WHERE id=?`,
      [name || null, email || null, province || null, farm_ha ?? null, req.user.id]
    );
    saveDb();
    res.json({ message: 'Profile updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/change-password
 */
router.post('/change-password', auth, async (req, res) => {
  try {
    const db = await getDb();
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password)
      return res.status(400).json({ error: 'old_password and new_password required' });
    if (new_password.length < 8)
      return res.status(400).json({ error: 'New password must be >= 8 chars' });

    const result = db.exec(`SELECT password FROM users WHERE id = '${req.user.id}'`);
    const hash = result[0].values[0][0];
    const ok = await bcrypt.compare(old_password, hash);
    if (!ok) return res.status(401).json({ error: 'Old password incorrect' });

    const newHash = await bcrypt.hash(new_password, 12);
    db.run(`UPDATE users SET password = ? WHERE id = ?`, [newHash, req.user.id]);
    saveDb();
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
