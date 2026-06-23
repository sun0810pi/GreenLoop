const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb, saveDb } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
const ALERT_THRESHOLD = 5.0; // g/L - trigger season-switch alert

function toObjects(result) {
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

/**
 * GET /api/salinity — latest readings per station
 * ?province=ca-mau&alert=true
 */
router.get('/', auth, async (req, res) => {
  try {
    const db = await getDb();
    const { province, alert } = req.query;

    let where = 'WHERE 1=1';
    if (province) where += ` AND province = '${province}'`;
    if (alert === 'true') where += ` AND alert = 1`;

    // Latest reading per station
    const result = db.exec(`
      SELECT s1.*
      FROM salinity_readings s1
      INNER JOIN (
        SELECT station, MAX(recorded_at) as max_at FROM salinity_readings GROUP BY station
      ) s2 ON s1.station = s2.station AND s1.recorded_at = s2.max_at
      ${where}
      ORDER BY s1.value_gpl DESC
    `);

    const data = toObjects(result);
    const alertCount = data.filter(r => r.alert).length;

    res.json({
      data,
      summary: {
        total_stations: data.length,
        alert_stations: alertCount,
        threshold_gpl: ALERT_THRESHOLD,
        recommendation: alertCount > 0
          ? 'Season switch recommended — intrusion exceeds 5 g/L at some stations'
          : 'Salinity within normal range — rice season conditions OK'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/salinity/history/:station — time-series for a station
 * ?days=30
 */
router.get('/history/:station', auth, async (req, res) => {
  try {
    const db = await getDb();
    const days = parseInt(req.query.days) || 30;
    const station = decodeURIComponent(req.params.station);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const result = db.exec(`
      SELECT recorded_at, value_gpl, alert
      FROM salinity_readings
      WHERE station = '${station.replace(/'/g, "''")}' AND recorded_at >= '${since}'
      ORDER BY recorded_at ASC
    `);

    res.json({ station, days, data: toObjects(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/salinity/provinces — summary by province
 */
router.get('/provinces', auth, async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec(`
      SELECT province,
             COUNT(*) as station_count,
             AVG(value_gpl) as avg_gpl,
             MAX(value_gpl) as max_gpl,
             SUM(alert) as alert_count
      FROM salinity_readings s1
      INNER JOIN (
        SELECT station, MAX(recorded_at) as max_at FROM salinity_readings GROUP BY station
      ) s2 ON s1.station = s2.station AND s1.recorded_at = s2.max_at
      GROUP BY province
      ORDER BY max_gpl DESC
    `);
    res.json({ data: toObjects(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/salinity — ingest new reading (HTX / admin / system)
 * Body: { station, province, river?, value_gpl, recorded_at?, source? }
 */
router.post('/', requireRole('htx', 'admin'), async (req, res) => {
  try {
    const db = await getDb();
    const { station, province, river, value_gpl, recorded_at, source = 'manual' } = req.body;
    if (!station || !province || value_gpl === undefined)
      return res.status(400).json({ error: 'station, province, value_gpl required' });

    const isAlert = value_gpl >= ALERT_THRESHOLD;
    const id = uuidv4();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO salinity_readings (id,station,province,river,value_gpl,recorded_at,source,alert,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, station, province, river || null, value_gpl, recorded_at || now, source, isAlert ? 1 : 0, now]
    );

    // Broadcast alert notification if above threshold
    if (isAlert) {
      db.run(`INSERT INTO notifications (id,user_id,title,body,type,created_at) VALUES (?,?,?,?,?,?)`,
        [uuidv4(), null,  // null = broadcast
         `⚠️ Salinity Alert — ${station}`,
         `${station} (${province}) reads ${value_gpl} g/L — above ${ALERT_THRESHOLD} g/L threshold. Consider switching to shrimp season.`,
         'alert', now]);
    }

    saveDb();
    res.status(201).json({ id, alert: isAlert, threshold: ALERT_THRESHOLD });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/salinity/season-advice — AI-simple rule engine for season recommendation
 */
router.get('/season-advice', auth, async (req, res) => {
  try {
    const db = await getDb();
    const province = req.query.province || req.user.province;
    if (!province) return res.status(400).json({ error: 'province required' });

    const result = db.exec(`
      SELECT value_gpl FROM salinity_readings
      WHERE province = '${province}'
      ORDER BY recorded_at DESC LIMIT 3
    `);

    const readings = result.length ? result[0].values.map(r => r[0]) : [];
    const avgRecent = readings.length ? readings.reduce((a, b) => a + b, 0) / readings.length : null;

    let advice, season;
    if (avgRecent === null) {
      advice = 'No data available for this province.';
      season = 'unknown';
    } else if (avgRecent >= ALERT_THRESHOLD) {
      season = 'shrimp';
      advice = `Average salinity ${avgRecent.toFixed(1)} g/L — above 5 g/L. Recommended: switch to dry-season shrimp. Pond sludge biomass eligible for carbon credits.`;
    } else if (avgRecent >= 2.5) {
      season = 'transition';
      advice = `Salinity ${avgRecent.toFixed(1)} g/L — borderline. Monitor daily. Rice season still viable but prepare for transition.`;
    } else {
      season = 'rice';
      advice = `Salinity ${avgRecent.toFixed(1)} g/L — safe for rice. Wet season conditions optimal. Rice straw eligible for biochar.`;
    }

    res.json({ province, avg_gpl: avgRecent, recommended_season: season, advice, based_on_readings: readings.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
