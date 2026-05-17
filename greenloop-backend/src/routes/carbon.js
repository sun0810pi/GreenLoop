const express = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { getDb, saveDb } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

// EBC carbon factor: 1 kg biochar ≈ 3.12 kg CO₂e (VM0044 conservative estimate)
const EBC_FACTOR = 3.12;
// AICE SCU price oracle (mock, USD per tonne)
const SCU_PRICE_USD = 20.0;

function toObjects(result) {
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

function makePassportHash(record) {
  const payload = JSON.stringify({ id: record.id, user_id: record.user_id, biochar_kg: record.biochar_kg, co2e_tonnes: record.co2e_tonnes, created_at: record.created_at });
  return 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * GET /api/carbon — my carbon records (farmer) or all (admin)
 */
router.get('/', auth, async (req, res) => {
  try {
    const db = await getDb();
    const { status, season, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let where = req.user.role === 'farmer' ? `WHERE cr.user_id = '${req.user.id}'` : 'WHERE 1=1';
    if (status) where += ` AND cr.status = '${status}'`;
    if (season) where += ` AND cr.season = '${season}'`;

    const result = db.exec(`
      SELECT cr.*, u.name as farmer_name, p.biomass_type, p.location
      FROM carbon_records cr
      JOIN users u ON cr.user_id = u.id
      LEFT JOIN pickups p ON cr.pickup_id = p.id
      ${where}
      ORDER BY cr.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `);
    const countRes = db.exec(`SELECT COUNT(*) FROM carbon_records cr ${where}`);
    const total = countRes[0]?.values[0][0] || 0;

    res.json({ data: toObjects(result), total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/carbon/summary — totals for my account
 */
router.get('/summary', auth, async (req, res) => {
  try {
    const db = await getDb();
    const uid = req.user.id;

    const totals = db.exec(`
      SELECT
        SUM(biochar_kg) as total_biochar_kg,
        SUM(co2e_tonnes) as total_co2e,
        SUM(scu_units) as total_scu,
        SUM(revenue_usd) as total_revenue_usd,
        COUNT(*) as record_count
      FROM carbon_records WHERE user_id = '${uid}'
    `);
    const byStatus = db.exec(`
      SELECT status, COUNT(*) as count, SUM(co2e_tonnes) as co2e
      FROM carbon_records WHERE user_id = '${uid}' GROUP BY status
    `);
    const bySeason = db.exec(`
      SELECT season, SUM(biochar_kg) as biochar_kg, SUM(co2e_tonnes) as co2e_tonnes
      FROM carbon_records WHERE user_id = '${uid}' GROUP BY season
    `);
    const pointsRes = db.exec(`SELECT SUM(CASE WHEN type='earned' THEN amount ELSE -amount END) as balance FROM points WHERE user_id = '${uid}'`);

    const t = totals[0]?.values[0] || [];
    res.json({
      total_biochar_kg: t[0] || 0,
      total_co2e_tonnes: t[1] || 0,
      total_scu_units: t[2] || 0,
      total_revenue_usd: t[3] || 0,
      record_count: t[4] || 0,
      points_balance: pointsRes[0]?.values[0][0] || 0,
      by_status: toObjects(byStatus),
      by_season: toObjects(bySeason),
      scu_price_usd: SCU_PRICE_USD
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/carbon/:id — single carbon record + MRV trail
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec(`
      SELECT cr.*, u.name as farmer_name, u.province
      FROM carbon_records cr JOIN users u ON cr.user_id = u.id
      WHERE cr.id = '${req.params.id}'
    `);
    if (!result.length || !result[0].values.length)
      return res.status(404).json({ error: 'Carbon record not found' });

    const record = toObjects(result)[0];
    if (req.user.role === 'farmer' && record.user_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });

    // MRV trail
    const mrvResult = db.exec(`SELECT * FROM mrv_logs WHERE carbon_id = '${req.params.id}' ORDER BY logged_at ASC`);
    record.mrv_trail = toObjects(mrvResult);

    res.json({ data: record });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/carbon — manually create a carbon record (htx/admin)
 * Normally auto-created when pickup status → 'processed'
 */
router.post('/', requireRole('htx', 'admin'), async (req, res) => {
  try {
    const db = await getDb();
    const { user_id, pickup_id, biochar_kg, season } = req.body;
    if (!user_id || !biochar_kg)
      return res.status(400).json({ error: 'user_id and biochar_kg required' });

    const co2e = (biochar_kg * EBC_FACTOR / 1000).toFixed(4);
    const id = uuidv4();
    const now = new Date().toISOString();

    // Build passport hash after record created
    const hashPayload = { id, user_id, biochar_kg, co2e_tonnes: co2e, created_at: now };
    const passportHash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(hashPayload)).digest('hex');

    db.run(
      `INSERT INTO carbon_records (id,user_id,pickup_id,biochar_kg,co2e_tonnes,season,passport_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [id, user_id, pickup_id || null, biochar_kg, co2e, season || null, passportHash, now]
    );
    saveDb();
    res.status(201).json({ id, co2e_tonnes: co2e, passport_hash: passportHash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/carbon/:id/verify — HTX/admin: move to verified + add MRV log
 */
router.post('/:id/verify', requireRole('htx', 'admin'), async (req, res) => {
  try {
    const db = await getDb();
    const { tier = 2, notes } = req.body;
    const now = new Date().toISOString();

    const result = db.exec(`SELECT * FROM carbon_records WHERE id = '${req.params.id}'`);
    if (!result.length || !result[0].values.length)
      return res.status(404).json({ error: 'Record not found' });
    const record = toObjects(result)[0];

    // Generate passport hash if not set
    const passportHash = record.passport_hash || makePassportHash(record);
    db.run(
      `UPDATE carbon_records SET status='verified', passport_hash=?, verified_at=? WHERE id=?`,
      [passportHash, now, req.params.id]
    );

    db.run(`INSERT INTO mrv_logs (id,carbon_id,tier,action,operator,data_hash,notes,logged_at) VALUES (?,?,?,?,?,?,?,?)`,
      [uuidv4(), req.params.id, tier,
       tier === 2 ? 'Lab analysis verified (EBC)' : 'Third-party audit complete',
       req.user.name, passportHash, notes || null, now]);

    saveDb();
    res.json({ message: 'Verified', passport_hash: passportHash, status: 'verified' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/carbon/:id/issue — issue SCU credits (admin only)
 */
router.post('/:id/issue', requireRole('admin'), async (req, res) => {
  try {
    const db = await getDb();
    const now = new Date().toISOString();

    const result = db.exec(`SELECT * FROM carbon_records WHERE id = '${req.params.id}'`);
    if (!result.length || !result[0].values.length)
      return res.status(404).json({ error: 'Record not found' });
    const record = toObjects(result)[0];
    if (record.status !== 'verified')
      return res.status(400).json({ error: 'Record must be verified before issuing SCU' });

    const scu = parseFloat(record.co2e_tonnes);
    const revenue = (scu * SCU_PRICE_USD).toFixed(2);

    db.run(`UPDATE carbon_records SET status='issued', scu_units=?, revenue_usd=? WHERE id=?`,
      [scu, revenue, req.params.id]);

    db.run(`INSERT INTO mrv_logs (id,carbon_id,tier,action,operator,logged_at) VALUES (?,?,?,?,?,?)`,
      [uuidv4(), req.params.id, 3, `${scu} SCU issued on AICE exchange @ $${SCU_PRICE_USD}/tonne`, 'GreenLoop Admin', now]);

    // Notify farmer
    db.run(`INSERT INTO notifications (id,user_id,title,body,type,created_at) VALUES (?,?,?,?,?,?)`,
      [uuidv4(), record.user_id,
       '💰 Carbon Credits Issued!',
       `${scu} SCU issued. Estimated revenue: $${revenue} USD. Listed on AICE Exchange.`,
       'success', now]);

    saveDb();
    res.json({ scu_units: scu, revenue_usd: Number(revenue), status: 'issued' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
