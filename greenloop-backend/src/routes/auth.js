const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb, saveDb } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'greenloop-secret-change-in-prod';
const JWT_EXPIRES = '7d';

function queryRows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const output = [];
  while (stmt.step()) output.push(stmt.getAsObject());
  stmt.free();
  return output;
}

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
    if (!['farmer', 'htx', 'buyer', 'partner'].includes(role))
      return res.status(400).json({ error: 'Invalid role' });

    // Check duplicate
    const existing = queryRows(db, 'SELECT id FROM users WHERE phone = ?', [phone]);
    if (existing.length)
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

    const user = queryRows(db, 'SELECT * FROM users WHERE phone = ? OR lower(email) = lower(?)', [phone, phone])[0];
    if (!user)
      return res.status(401).json({ error: 'Invalid credentials' });

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

router.post('/demo', async (_req, res) => {
  try {
    const db = await getDb();
    const now = new Date().toISOString();
    const userId = 'user-demo-ready-001';
    const phone = '0901234567';
    const existing = queryRows(db, 'SELECT * FROM users WHERE id = ? OR phone = ?', [userId, phone])[0];
    const demoUserId = existing?.id || userId;
    const hash = await bcrypt.hash('demo1234', 12);
    if (!existing) {
      db.run(
        `INSERT INTO users (id,name,phone,email,password,role,province,farm_ha,htx_code,created_at,last_login)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [demoUserId, 'Nguyễn Văn Thanh', phone, 'demo.farmer@greenloop.vn', hash, 'farmer', 'ca-mau', 2.4, 'HTX-CM-01', now, now]
      );
    }

    const plotId = 'plot-demo-ready-001';
    const boundary = JSON.stringify([
      { lat: 9.17695, lng: 105.15168 },
      { lat: 9.17755, lng: 105.15242 },
      { lat: 9.17692, lng: 105.15318 },
      { lat: 9.17625, lng: 105.15245 }
    ]);
    if (!queryRows(db, 'SELECT id FROM field_plots WHERE id = ?', [plotId]).length) {
      db.run(
        `INSERT INTO field_plots (id,user_id,name,province,area_ha,crop_type,lat,lng,boundary,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [plotId, demoUserId, 'Mảnh lúa xác minh A', 'ca-mau', 1.28, 'rice', 9.1769, 105.1524, boundary, now, now]
      );
    }

    const reqId = 'iot-demo-ready-001';
    if (!queryRows(db, 'SELECT id FROM iot_install_requests WHERE id = ?', [reqId]).length) {
      db.run(
        `INSERT INTO iot_install_requests (id,plot_id,user_id,status,requested_sensors,admin_id,admin_notes,requested_at,decided_at,installed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [reqId, plotId, demoUserId, 'installed', '["salinity","ph","moisture"]', 'admin-demo', 'Đã xác minh ranh giới ruộng và lắp bộ cảm biến nước.', now, now, now]
      );
    }

    const pickupId = 'pickup-demo-ready-001';
    if (!queryRows(db, 'SELECT id FROM pickups WHERE id = ?', [pickupId]).length) {
      db.run(
        `INSERT INTO pickups
         (id,user_id,biomass_type,quantity_kg,location,province,scheduled_at,status,biochar_yield_kg,created_at,updated_at,
          sale_price_vnd,buyer_name,payment_status,farmer_share_vnd,htx_share_vnd,platform_share_vnd,advance_vnd,payment_evidence_hash,buyer_paid_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [pickupId, demoUserId, 'rice_straw', 1250, 'Mảnh lúa xác minh A - Cà Mau', 'ca-mau', now, 'processed', 375, now, now,
         1800000, 'Mekong Biochar Buyer', 'buyer_paid', 1260000, 360000, 180000, 500000, 'sha256:demo-biomass-sale-ledger', now]
      );
    } else {
      db.run(
        `UPDATE pickups
         SET sale_price_vnd=COALESCE(NULLIF(sale_price_vnd,0),?),
             buyer_name=COALESCE(buyer_name,?),
             payment_status=CASE WHEN payment_status IS NULL OR payment_status='pending' THEN 'buyer_paid' ELSE payment_status END,
             farmer_share_vnd=COALESCE(NULLIF(farmer_share_vnd,0),?),
             htx_share_vnd=COALESCE(NULLIF(htx_share_vnd,0),?),
             platform_share_vnd=COALESCE(NULLIF(platform_share_vnd,0),?),
             advance_vnd=COALESCE(NULLIF(advance_vnd,0),?),
             payment_evidence_hash=COALESCE(payment_evidence_hash,?),
             buyer_paid_at=COALESCE(buyer_paid_at,?)
         WHERE id=?`,
        [1800000, 'Mekong Biochar Buyer', 1260000, 360000, 180000, 500000, 'sha256:demo-biomass-sale-ledger', now, pickupId]
      );
    }

    const carbonId = 'carbon-demo-ready-001';
    if (!queryRows(db, 'SELECT id FROM carbon_records WHERE id = ?', [carbonId]).length) {
      db.run(
        `INSERT INTO carbon_records (id,user_id,pickup_id,biochar_kg,co2e_tonnes,methodology,status,passport_hash,scu_units,revenue_usd,season,created_at,verified_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [carbonId, demoUserId, pickupId, 375, 0.94, 'Verra VM0044', 'verified', 'sha256:demo-ready-carbon-passport', 0.94, 18.8, 'wet_rice', now, now]
      );
    }

    saveDb();
    const user = queryRows(db, 'SELECT id,name,phone,email,role,province,farm_ha,htx_code,created_at,last_login FROM users WHERE id = ?', [demoUserId])[0];
    const token = jwt.sign({ id: user.id, name: user.name, phone: user.phone, role: user.role, province: user.province }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ token, user });
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
    const user = queryRows(db, 'SELECT id,name,phone,email,role,province,farm_ha,htx_code,created_at,last_login FROM users WHERE id = ?', [req.user.id])[0];
    if (!user)
      return res.status(404).json({ error: 'User not found' });
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

    const row = queryRows(db, 'SELECT password FROM users WHERE id = ?', [req.user.id])[0];
    if (!row) return res.status(404).json({ error: 'User not found' });
    const hash = row.password;
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
