const express = require('express');
const { getDb, saveDb } = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
function toObjects(result) {
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

/**
 * GET /api/admin/stats — platform-wide dashboard
 */
router.get('/stats', requireRole('admin', 'htx'), async (req, res) => {
  try {
    const db = await getDb();

    const users    = db.exec("SELECT role, COUNT(*) as count FROM users GROUP BY role");
    const pickups  = db.exec("SELECT status, COUNT(*) as count, SUM(quantity_kg) as total_kg FROM pickups GROUP BY status");
    const carbon   = db.exec("SELECT SUM(co2e_tonnes) as total_co2e, SUM(scu_units) as total_scu, SUM(revenue_usd) as total_revenue FROM carbon_records WHERE status IN ('issued','traded')");
    const biochar  = db.exec("SELECT SUM(biochar_yield_kg) as total_biochar_kg FROM pickups WHERE status='processed'");
    const alerts   = db.exec("SELECT COUNT(*) as active_alerts FROM salinity_readings s1 INNER JOIN (SELECT station, MAX(recorded_at) as max_at FROM salinity_readings GROUP BY station) s2 ON s1.station=s2.station AND s1.recorded_at=s2.max_at WHERE s1.alert=1");

    const c = carbon[0]?.values[0] || [];
    res.json({
      users_by_role: toObjects(users),
      pickups_by_status: toObjects(pickups),
      platform: {
        total_co2e_tonnes: c[0] || 0,
        total_scu_issued: c[1] || 0,
        total_revenue_usd: c[2] || 0,
        total_biochar_kg: biochar[0]?.values[0][0] || 0,
        active_salinity_alerts: alerts[0]?.values[0][0] || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/users — list all users
 */
router.get('/users', requireRole('admin'), async (req, res) => {
  try {
    const db = await getDb();
    const { role, province, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    if (role) where += ` AND role = '${role}'`;
    if (province) where += ` AND province = '${province}'`;

    const result = db.exec(`SELECT id,name,phone,email,role,province,farm_ha,htx_code,created_at,last_login FROM users ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`);
    const countRes = db.exec(`SELECT COUNT(*) FROM users ${where}`);
    res.json({ data: toObjects(result), total: countRes[0]?.values[0][0] || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/admin/users/:id/role — change user role
 */
router.patch('/users/:id/role', requireRole('admin'), async (req, res) => {
  try {
    const db = await getDb();
    const { role } = req.body;
    if (!['farmer', 'htx', 'buyer', 'admin'].includes(role))
      return res.status(400).json({ error: 'Invalid role' });
    db.run(`UPDATE users SET role=? WHERE id=?`, [role, req.params.id]);
    saveDb();
    res.json({ message: `Role updated to ${role}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
