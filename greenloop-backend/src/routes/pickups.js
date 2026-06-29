const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb, saveDb } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { getBiomassType, isBiomassType, normalizeBiomassType } = require('../biomass');

const router = express.Router();

// Helper: rows → objects
function toObjects(result) {
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

/**
 * POST /api/pickups — book a new pickup
 */
router.post('/', auth, async (req, res) => {
  try {
    const db = await getDb();
    const { biomass_type, quantity_kg, location, province, scheduled_at, notes, htx_code } = req.body;

    const normalizedType = normalizeBiomassType(biomass_type);
    if (!biomass_type || !quantity_kg || !location || !province || !scheduled_at)
      return res.status(400).json({ error: 'biomass_type, quantity_kg, location, province, scheduled_at required' });
    if (!isBiomassType(normalizedType))
      return res.status(400).json({ error: 'Unsupported biomass_type' });
    if (quantity_kg < 500)
      return res.status(400).json({ error: 'Minimum pickup is 500 kg' });

    const id = uuidv4();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO pickups (id,user_id,biomass_type,quantity_kg,location,province,scheduled_at,notes,htx_code,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.user.id, normalizedType, quantity_kg, location, province, scheduled_at, notes || null, htx_code || req.user.htx_code || null, now, now]
    );

    // Award points: 1 pt per kg at booking
    db.run(`INSERT INTO points (id,user_id,amount,type,reason,ref_id,created_at) VALUES (?,?,?,?,?,?,?)`,
      [uuidv4(), req.user.id, Math.floor(quantity_kg), 'earned', '1 pt per kg booked', id, now]);

    // Create notification
    db.run(`INSERT INTO notifications (id,user_id,title,body,type,created_at) VALUES (?,?,?,?,?,?)`,
      [uuidv4(), req.user.id,
       '📦 Pickup Confirmed',
       `Your ${normalizedType.replace('_', ' ')} pickup (${quantity_kg} kg) scheduled for ${new Date(scheduled_at).toLocaleDateString('vi-VN')}.`,
       'success', now]);

    saveDb();
    const biomass = getBiomassType(normalizedType);
    res.status(201).json({ id, status: 'pending', biomass_type: normalizedType, processing_output: biomass.output, mrv_pathway: biomass.mrv_pathway, estimated_biochar_kg: biomass.carbon_factor ? Math.round(quantity_kg * biomass.yield_factor) : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/pickups — list my pickups (farmer) or all by province (htx/admin)
 */
router.get('/', auth, async (req, res) => {
  try {
    const db = await getDb();
    const { status, province, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let where = req.user.role === 'farmer' ? `WHERE p.user_id = '${req.user.id}'` : 'WHERE 1=1';
    if (status) where += ` AND p.status = '${status}'`;
    if (province && req.user.role !== 'farmer') where += ` AND p.province = '${province}'`;

    const result = db.exec(
      `SELECT p.*, u.name as farmer_name, u.phone as farmer_phone
       FROM pickups p JOIN users u ON p.user_id = u.id
       ${where} ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${offset}`
    );
    const countRes = db.exec(`SELECT COUNT(*) FROM pickups p ${where}`);
    const total = countRes[0]?.values[0][0] || 0;

    res.json({ data: toObjects(result), total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/pickups/:id — single pickup detail
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec(
      `SELECT p.*, u.name as farmer_name FROM pickups p JOIN users u ON p.user_id = u.id WHERE p.id = '${req.params.id}'`
    );
    if (!result.length || !result[0].values.length)
      return res.status(404).json({ error: 'Pickup not found' });

    const pickup = toObjects(result)[0];
    // Farmers can only view their own
    if (req.user.role === 'farmer' && pickup.user_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });

    res.json({ data: pickup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/pickups/:id/status — HTX/admin updates pickup status
 * Body: { status, biochar_yield_kg?, notes? }
 */
router.patch('/:id/status', requireRole('htx', 'admin'), async (req, res) => {
  try {
    const db = await getDb();
    const { status, biochar_yield_kg, notes } = req.body;
    const validStatuses = ['pending', 'confirmed', 'collected', 'processed', 'cancelled'];
    if (!validStatuses.includes(status))
      return res.status(400).json({ error: `status must be: ${validStatuses.join(' | ')}` });

    const now = new Date().toISOString();
    db.run(
      `UPDATE pickups SET status=?, biochar_yield_kg=COALESCE(?,biochar_yield_kg), notes=COALESCE(?,notes), updated_at=? WHERE id=?`,
      [status, biochar_yield_kg || null, notes || null, now, req.params.id]
    );

    // If processed → auto-generate carbon record
    if (status === 'processed' && biochar_yield_kg) {
      const pickupRes = db.exec(`SELECT * FROM pickups WHERE id = '${req.params.id}'`);
      const pickup = toObjects(pickupRes)[0];
      const biomass = getBiomassType(pickup.biomass_type);
      if (!biomass?.carbon_factor) {
        saveDb();
        return res.json({ message: 'Status updated; this bio-product requires its own MRV pathway', status });
      }
      const co2e = (biochar_yield_kg * biomass.carbon_factor / 1000).toFixed(4);
      const season = biomass.season;
      const carbonId = uuidv4();
      const passportPayload = JSON.stringify({ carbonId, pickup_id: pickup.id, user_id: pickup.user_id, biomass_type: pickup.biomass_type, biochar_yield_kg, co2e, season, processed_at: now });
      const passportHash = 'sha256:' + require('crypto').createHash('sha256').update(passportPayload).digest('hex');

      db.run(
        `INSERT INTO carbon_records (id,user_id,pickup_id,biochar_kg,co2e_tonnes,season,passport_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`,
        [carbonId, pickup.user_id, pickup.id, biochar_yield_kg, co2e, season, passportHash, now]
      );

      // Notify farmer
      db.run(`INSERT INTO notifications (id,user_id,title,body,type,created_at) VALUES (?,?,?,?,?,?)`,
        [uuidv4(), pickup.user_id,
         '🌱 Biochar Processed!',
         `${biochar_yield_kg} kg biochar produced. Estimated ${co2e} tCO₂e pending verification.`,
         'success', now]);

      // MRV tier 1 log
      db.run(`INSERT INTO mrv_logs (id,carbon_id,tier,action,operator,logged_at) VALUES (?,?,?,?,?,?)`,
        [uuidv4(), carbonId, 1, 'Field mass verified by HTX', req.user.name, now]);
      db.run(`INSERT INTO mrv_logs (id,carbon_id,tier,action,operator,data_hash,notes,logged_at) VALUES (?,?,?,?,?,?,?,?)`,
        [uuidv4(), carbonId, 1, 'Chain-of-custody passport anchored', req.user.name, passportHash, biomass.mrv_pathway, now]);
    }

    saveDb();
    res.json({ message: 'Status updated', status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/pickups/:id — cancel (farmer own pending pickup)
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec(`SELECT * FROM pickups WHERE id = '${req.params.id}'`);
    if (!result.length || !result[0].values.length)
      return res.status(404).json({ error: 'Pickup not found' });
    const pickup = toObjects(result)[0];
    if (pickup.user_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });
    if (!['pending', 'confirmed'].includes(pickup.status))
      return res.status(400).json({ error: 'Only pending/confirmed pickups can be cancelled' });

    db.run(`UPDATE pickups SET status='cancelled', updated_at=? WHERE id=?`,
      [new Date().toISOString(), req.params.id]);
    saveDb();
    res.json({ message: 'Pickup cancelled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
