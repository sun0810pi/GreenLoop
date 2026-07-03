const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb, saveDb } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
// Initial business decision tiers for demo v1. These thresholds must be validated with agronomists
// and local salinity station history before production use.
const SALINITY_DECISION_TIERS = [
  { key: 'rice', min: 0, max: 2, advice: 'Lúa thường vẫn an toàn, tiếp tục mùa vụ hiện tại' },
  { key: 'rice_st25', min: 2, max: 4, advice: 'Chuyển sang giống lúa chịu mặn ST25 ngay vụ tới' },
  { key: 'transition', min: 4, max: 6, advice: 'Vùng chuyển tiếp: ST25 + bắt đầu trồng xen tràm ở khu vực trũng/ven kênh' },
  { key: 'tram_shrimp', min: 6, max: Infinity, advice: 'Chuyển hẳn sang tràm + nuôi tôm nước lợ, ngừng vụ lúa' }
];
const SENSOR_ALERT_GPL = 5.0; // field sensor alert threshold; separate from the decision tiers above
const ML_ROADMAP = 'Mô hình ML huấn luyện trên dữ liệu lịch sử MRC + vệ tinh — giai đoạn pilot kế tiếp';
const SALINITY_PROXY_DISCLAIMER = 'Ước tính proxy từ dữ liệu thủy văn công khai, không thay thế đo mặn tại hiện trường';
const PROXY_LOCATIONS = {
  'ca-mau': {
    name: 'Cà Mau',
    river: 'Gành Hào / cửa sông Cà Mau',
    latitude: 9.1768,
    longitude: 105.1524,
    lowDischargeM3s: 2.5,
    coastalBaseGpl: 5.2
  },
  'soc-trang': {
    name: 'Sóc Trăng',
    river: 'Sông Hậu gần cửa Định An',
    latitude: 9.6037,
    longitude: 105.9739,
    lowDischargeM3s: 16,
    coastalBaseGpl: 4.8
  },
  'bac-lieu': {
    name: 'Bạc Liêu',
    river: 'Bạc Liêu / Gành Hào',
    latitude: 9.2941,
    longitude: 105.7278,
    lowDischargeM3s: 1.8,
    coastalBaseGpl: 4.9
  },
  'kien-giang': {
    name: 'Kiên Giang',
    river: 'Cái Lớn - Cái Bé',
    latitude: 9.8249,
    longitude: 105.1259,
    lowDischargeM3s: 24,
    coastalBaseGpl: 3.6
  }
};

function toObjects(result) {
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

function normalizeProvince(value) {
  return String(value || 'ca-mau').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-');
}

function recentDateRange(days = 7) {
  const end = new Date();
  const start = new Date(Date.now() - (days - 1) * 86400000);
  const fmt = date => date.toISOString().slice(0, 10).replace(/-/g, '');
  return { start: fmt(start), end: fmt(end) };
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

async function fetchOpenMeteoFlood(location) {
  const url = new URL('https://flood-api.open-meteo.com/v1/flood');
  url.searchParams.set('latitude', location.latitude);
  url.searchParams.set('longitude', location.longitude);
  url.searchParams.set('daily', 'river_discharge');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo Flood ${response.status}`);
  const payload = await response.json();
  const values = payload.daily?.river_discharge || [];
  const firstWeek = values.slice(0, 7);
  const latest = values.map(Number).find(Number.isFinite);
  return {
    latest_m3s: latest ?? null,
    average_m3s: average(firstWeek),
    unit: payload.daily_units?.river_discharge || 'm³/s',
    source: 'open_meteo_proxy'
  };
}

async function fetchNasaRain(location) {
  const { start, end } = recentDateRange(7);
  const url = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
  url.searchParams.set('parameters', 'PRECTOTCORR');
  url.searchParams.set('community', 'AG');
  url.searchParams.set('longitude', location.longitude);
  url.searchParams.set('latitude', location.latitude);
  url.searchParams.set('start', start);
  url.searchParams.set('end', end);
  url.searchParams.set('format', 'JSON');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`NASA POWER ${response.status}`);
  const payload = await response.json();
  const daily = payload.properties?.parameter?.PRECTOTCORR || {};
  const values = Object.values(daily).map(Number).filter(value => Number.isFinite(value) && value >= 0);
  return {
    total_rain_mm: values.reduce((sum, value) => sum + value, 0),
    dry_days: values.filter(value => value < 1).length,
    source: 'nasa_power_api'
  };
}

function classifyRisk(discharge, rain, location) {
  const latest = Number(discharge.latest_m3s);
  const rainTotal = Number(rain.total_rain_mm || 0);
  const dryDays = Number(rain.dry_days || 0);
  const lowFlow = Number.isFinite(latest) && latest < location.lowDischargeM3s;
  const veryLowFlow = Number.isFinite(latest) && latest < location.lowDischargeM3s * 0.7;
  const dry = rainTotal < 20 || dryDays >= 4;
  if (veryLowFlow && dry) return { risk_level: 'high', score: 85, label_vi: 'Nguy cơ mặn cao', label_en: 'High salinity-intrusion risk' };
  if (lowFlow && dry) return { risk_level: 'medium', score: 62, label_vi: 'Nguy cơ mặn trung bình', label_en: 'Medium salinity-intrusion risk' };
  if (lowFlow || dry) return { risk_level: 'watch', score: 44, label_vi: 'Cần theo dõi', label_en: 'Watch conditions' };
  return { risk_level: 'low', score: 24, label_vi: 'Nguy cơ mặn thấp', label_en: 'Low salinity-intrusion risk' };
}

function estimateProxySalinityGpl(discharge, rain, location) {
  const flow = Number(discharge.latest_m3s);
  const rainTotal = Number(rain.total_rain_mm || 0);
  const dryDays = Number(rain.dry_days || 0);
  const lowFlowPenalty = Number.isFinite(flow)
    ? Math.max(-0.5, Math.min(1.8, ((location.lowDischargeM3s - flow) / Math.max(location.lowDischargeM3s, 0.1)) * 1.6))
    : 0.4;
  const rainRelief = Math.min(1.1, rainTotal / 70);
  const dryPenalty = Math.min(0.8, dryDays * 0.14);
  return Math.max(0, Number((location.coastalBaseGpl + lowFlowPenalty + dryPenalty - rainRelief).toFixed(1)));
}

function decisionFromSalinity(value) {
  if (!Number.isFinite(Number(value))) {
    return {
      recommended_season: 'unknown',
      advice: 'Chưa đủ dữ liệu để ra quyết định mùa vụ',
      threshold_tier: 'unknown'
    };
  }
  const numeric = Number(value);
  const tier = SALINITY_DECISION_TIERS.find(item => numeric >= item.min && numeric < item.max) || SALINITY_DECISION_TIERS[SALINITY_DECISION_TIERS.length - 1];
  return {
    recommended_season: tier.key,
    advice: tier.advice,
    threshold_tier: tier.max === Infinity ? `>${tier.min} g/L` : `${tier.min}-${tier.max} g/L`
  };
}

async function buildOpenDataRiskProxy(provinceValue) {
  const key = normalizeProvince(provinceValue || 'ca-mau');
  const location = PROXY_LOCATIONS[key] || PROXY_LOCATIONS['ca-mau'];
  const [river, rain] = await Promise.all([
    fetchOpenMeteoFlood(location),
    fetchNasaRain(location)
  ]);
  const risk = classifyRisk(river, rain, location);
  const estimatedSalinity = estimateProxySalinityGpl(river, rain, location);
  return {
    key,
    location,
    river,
    rain,
    risk,
    estimated_salinity_gpl: estimatedSalinity,
    basis: ['open-meteo:river_discharge', 'nasa-power:PRECTOTCORR']
  };
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
        threshold_gpl: SENSOR_ALERT_GPL,
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
 * GET /api/salinity/risk-proxy
 * Public hydrology proxy: Open-Meteo river discharge + NASA POWER rainfall.
 * This does not pretend to be a field salinity sensor.
 */
router.get('/risk-proxy', auth, async (req, res) => {
  try {
    const proxy = await buildOpenDataRiskProxy(req.query.province || req.user.province || 'ca-mau');
    res.json({
      province: proxy.key,
      location: {
        name: proxy.location.name,
        river: proxy.location.river,
        latitude: proxy.location.latitude,
        longitude: proxy.location.longitude
      },
      source: 'open_meteo_proxy',
      risk_level: proxy.risk.risk_level,
      risk_score: proxy.risk.score,
      risk_label_vi: proxy.risk.label_vi,
      risk_label_en: proxy.risk.label_en,
      river_discharge_m3s: proxy.river.latest_m3s,
      river_discharge_avg_m3s: proxy.river.average_m3s,
      river_low_threshold_m3s: proxy.location.lowDischargeM3s,
      rainfall_7d_mm: proxy.rain.total_rain_mm,
      dry_days_7d: proxy.rain.dry_days,
      estimated_salinity_gpl: proxy.estimated_salinity_gpl,
      basis: proxy.basis,
      disclaimer: SALINITY_PROXY_DISCLAIMER,
      fetched_at: new Date().toISOString()
    });
  } catch (err) {
    res.status(502).json({
      error: err.message,
      source: 'open_meteo_proxy',
      basis: ['open-meteo:river_discharge', 'nasa-power:PRECTOTCORR'],
      disclaimer: SALINITY_PROXY_DISCLAIMER
    });
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

    const isAlert = value_gpl >= SENSOR_ALERT_GPL;
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
         `${station} (${province}) reads ${value_gpl} g/L — above ${SENSOR_ALERT_GPL} g/L threshold. Consider switching to shrimp season.`,
         'alert', now]);
    }

    saveDb();
    res.status(201).json({ id, alert: isAlert, threshold: SENSOR_ALERT_GPL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/salinity/season-advice — Rule-based decision engine v1 for season recommendation
 */
router.get('/season-advice', auth, async (req, res) => {
  try {
    const db = await getDb();
    const province = req.query.province || req.user.province;
    const provinceKey = normalizeProvince(province || 'ca-mau');
    if (!province) return res.status(400).json({ error: 'province required' });

    try {
      const proxy = await buildOpenDataRiskProxy(provinceKey);
      const decision = decisionFromSalinity(proxy.estimated_salinity_gpl);
      return res.json({
        province: proxy.key,
        recommended_season: decision.recommended_season,
        advice: decision.advice,
        avg_gpl_or_proxy_value: proxy.estimated_salinity_gpl,
        threshold_tier: decision.threshold_tier,
        engine: 'rule_based_v1',
        ml_roadmap: ML_ROADMAP,
        data_basis: 'open_data_proxy',
        sources: proxy.basis,
        source_values: {
          river_discharge_m3s: proxy.river.latest_m3s,
          rainfall_7d_mm: proxy.rain.total_rain_mm,
          dry_days_7d: proxy.rain.dry_days
        },
        disclaimer: SALINITY_PROXY_DISCLAIMER
      });
    } catch (proxyErr) {
      // Fallback only when open-data proxy is unavailable. Response marks this as seed_demo.
    }

    const result = db.exec(`
      SELECT value_gpl, source FROM salinity_readings
      WHERE province = '${provinceKey}'
      ORDER BY recorded_at DESC LIMIT 3
    `);

    const readings = result.length ? result[0].values.map(r => Number(r[0])).filter(Number.isFinite) : [];
    const avgRecent = readings.length ? readings.reduce((a, b) => a + b, 0) / readings.length : null;
    const decision = decisionFromSalinity(avgRecent);
    res.json({
      province: provinceKey,
      recommended_season: decision.recommended_season,
      advice: decision.advice,
      avg_gpl_or_proxy_value: avgRecent,
      threshold_tier: decision.threshold_tier,
      engine: 'rule_based_v1',
      ml_roadmap: ML_ROADMAP,
      data_basis: 'seed_demo',
      sources: ['salinity_readings:seed_demo'],
      based_on_readings: readings.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
