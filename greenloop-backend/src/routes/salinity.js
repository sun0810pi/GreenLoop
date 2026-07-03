const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb, saveDb } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { loadSalinityModel, predictWithSalinityModel, buildLatestMlFeatureContext } = require('../salinity-ml');

const router = express.Router();
// Current limitation: Open-Meteo river discharge and NASA POWER rainfall are usable input
// features with historical coverage, but they are not the salinity label. To train or
// calibrate a real model, GreenLoop still needs historical field salinity measurements
// by station/time from local hydromet centers, MRC datasets, or published research.
// Without those labels, this remains a rule-based proxy: the app runs, but the risk is
// recommendation accuracy rather than application stability.
const SALINITY_DECISION_TIERS = [
  { key: 'rice', min: 0, max: 2, advice: 'Lúa thường vẫn an toàn, tiếp tục mùa vụ hiện tại' },
  { key: 'rice_st25', min: 2, max: 4, advice: 'Chuyển sang giống lúa chịu mặn ST25 ngay vụ tới' },
  { key: 'transition', min: 4, max: 6, advice: 'Vùng chuyển tiếp: ST25 + bắt đầu trồng xen tràm ở khu vực trũng/ven kênh' },
  { key: 'tram_shrimp', min: 6, max: Infinity, advice: 'Chuyển hẳn sang tràm + nuôi tôm nước lợ, ngừng vụ lúa' }
];
const SENSOR_ALERT_GPL = 5.0; // field sensor alert threshold; separate from the decision tiers above
const ML_ROADMAP = 'Bước ML tiếp theo: dùng Open-Meteo + NASA POWER làm features, ghép với nhãn đo mặn thật từ trạm/MRC/báo cáo nghiên cứu để train và hiệu chỉnh mô hình';
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
// Compact copy of the ecosystem catalog used for salinity-driven recommendations.
// Scores are rule-based v1 for demo decisions, not a trained model.
const CULTIVATION_CATALOG = {
  zones: [
    { id: 'fresh_stable', min: 0, max: 1, name: 'Vùng ngọt ổn định', model: 'Lúa + thủy sản nước ngọt tuần hoàn', crops: ['Lúa thường'], species: ['pangasius', 'tilapia', 'eel', 'snakehead'] },
    { id: 'fresh_brackish', min: 1, max: 4, name: 'Vùng lợ ngọt linh hoạt', model: 'ST25 + thủy sản nước ngọt/lợ nhẹ', crops: ['ST25', 'lúa chịu mặn'], species: ['giant_freshwater_prawn', 'tilapia', 'red_tilapia'] },
    { id: 'brackish_transition', min: 4, max: 6, name: 'Vùng mặn lợ chuyển tiếp', model: 'ST25 + tràm ven kênh + thủy sản lợ', crops: ['ST25', 'tràm khu vực trũng/ven kênh'], species: ['shrimp', 'crab', 'mudskipper', 'mullet', 'blood_cockle'] },
    { id: 'saline_stable', min: 6, max: Infinity, name: 'Vùng mặn ổn định', model: 'Tràm + tôm nước lợ/mặn, ngừng vụ lúa', crops: ['tràm', 'cây ven biển chịu mặn'], species: ['shrimp', 'crab', 'clam', 'oyster', 'seaweed'] }
  ],
  species: {
    shrimp: { name: 'Tôm sú/tôm thẻ', range: [4, 25], residue: 'Vỏ, đầu và bùn hữu cơ', reason: 'Phù hợp nước lợ/mặn; giá trị thương mại cao nhưng cần quản lý pH, DO và độ mặn ổn định.' },
    crab: { name: 'Cua biển', range: [4, 20], residue: 'Vỏ cua và bùn ao', reason: 'Hợp vùng lợ, có thể nuôi xen trong mô hình lúa - thủy sản - tràm.' },
    mudskipper: { name: 'Cá kèo', range: [3, 18], residue: 'Bùn hữu cơ ao nuôi', reason: 'Chịu mặn tốt, phù hợp ao chuyển đổi và vùng ven kênh.' },
    mullet: { name: 'Cá đối mục', range: [4, 20], residue: 'Bùn hữu cơ và phụ phẩm cá', reason: 'Tận dụng thức ăn tự nhiên, hỗ trợ làm sạch ao trong vùng lợ.' },
    blood_cockle: { name: 'Sò huyết', range: [8, 25], residue: 'Vỏ nhuyễn thể', reason: 'Phù hợp vùng bãi bồi/mặn hơn; nên xem như lựa chọn sau khi độ mặn ổn định.' },
    clam: { name: 'Nghêu', range: [10, 30], residue: 'Vỏ nhuyễn thể', reason: 'Phù hợp vùng triều/cửa sông mặn ổn định, chi phí thức ăn thấp.' },
    oyster: { name: 'Hàu', range: [10, 30], residue: 'Vỏ hàu', reason: 'Hỗ trợ lọc nước, phù hợp cửa sông khi độ mặn cao và ổn định.' },
    seaweed: { name: 'Rong biển', range: [12, 35], residue: 'Sinh khối rong', reason: 'Phù hợp vùng mặn ổn định, bổ sung dòng sinh khối phi động vật.' },
    giant_freshwater_prawn: { name: 'Tôm càng xanh', range: [0, 4], residue: 'Vỏ và bùn hữu cơ', reason: 'Hợp vùng ngọt/lợ nhẹ, đi tốt với lúa chịu mặn như ST25.' },
    tilapia: { name: 'Cá rô phi', range: [0, 8], residue: 'Bùn hữu cơ và phụ phẩm cá', reason: 'Dễ nuôi, chịu biến động môi trường tốt, phù hợp giai đoạn thích ứng.' },
    red_tilapia: { name: 'Cá điêu hồng', range: [0, 6], residue: 'Bùn hữu cơ và phụ phẩm cá', reason: 'Phù hợp vùng ngọt/lợ nhẹ, thị trường quen thuộc.' },
    pangasius: { name: 'Cá tra', range: [0, 2], residue: 'Bùn hữu cơ và phụ phẩm cá', reason: 'Phù hợp vùng nước ngọt ổn định, không nên ưu tiên khi mặn tăng.' },
    eel: { name: 'Lươn', range: [0, 2], residue: 'Bùn hữu cơ nhẹ', reason: 'Giá trị cao, phù hợp diện tích nhỏ và nước ngọt ổn định.' },
    snakehead: { name: 'Cá lóc', range: [0, 3], residue: 'Phụ phẩm cá', reason: 'Phù hợp nông hộ vùng ngọt/lợ rất nhẹ.' }
  }
};

function toObjects(result) {
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

function queryObjects(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
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

function salinityLabelSummary(db, province) {
  const where = province ? 'WHERE province = ?' : '';
  const params = province ? [province] : [];
  const summary = queryObjects(db, `
    SELECT
      COUNT(*) AS labels,
      COUNT(DISTINCT station) AS stations,
      MIN(recorded_date) AS first_date,
      MAX(recorded_date) AS last_date,
      ROUND(AVG(salinity_gpl), 2) AS avg_salinity_gpl,
      ROUND(MAX(salinity_gpl), 2) AS max_salinity_gpl
    FROM salinity_labels
    ${where}
  `, params)[0] || {};
  const byStation = queryObjects(db, `
    SELECT
      station,
      province,
      ROUND(AVG(latitude), 5) AS latitude,
      ROUND(AVG(longitude), 5) AS longitude,
      COUNT(*) AS labels,
      MIN(recorded_date) AS first_date,
      MAX(recorded_date) AS last_date,
      ROUND(AVG(salinity_gpl), 2) AS avg_salinity_gpl,
      ROUND(MAX(salinity_gpl), 2) AS max_salinity_gpl
    FROM salinity_labels
    ${where}
    GROUP BY station, province
    ORDER BY province, station
  `, params);
  return {
    ...summary,
    source: 'historical_station_dataset',
    stations_detail: byStation
  };
}

function resolveMlLocation(db, province, station) {
  const provinceKey = normalizeProvince(province || 'ca-mau');
  if (station) {
    const exact = queryObjects(
      db,
      `SELECT station, province, latitude, longitude
       FROM salinity_labels
       WHERE province = ? AND LOWER(station) = LOWER(?)
       LIMIT 1`,
      [provinceKey, station]
    )[0];
    if (exact) {
      return {
        name: exact.station,
        province: exact.province,
        latitude: Number(exact.latitude),
        longitude: Number(exact.longitude)
      };
    }
  }
  const provincePoint = queryObjects(
    db,
    `SELECT province, ROUND(AVG(latitude), 6) AS latitude, ROUND(AVG(longitude), 6) AS longitude
     FROM salinity_labels
     WHERE province = ?
     GROUP BY province`,
    [provinceKey]
  )[0];
  if (provincePoint) {
    return {
      name: provinceKey,
      province: provinceKey,
      latitude: Number(provincePoint.latitude),
      longitude: Number(provincePoint.longitude)
    };
  }
  const fallback = PROXY_LOCATIONS[provinceKey] || PROXY_LOCATIONS['ca-mau'];
  return {
    name: fallback.name,
    province: provinceKey,
    latitude: Number(fallback.latitude),
    longitude: Number(fallback.longitude)
  };
}

function interpolateDailyLabels(rows) {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => new Date(a.recorded_date) - new Date(b.recorded_date));
  const output = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    const start = new Date(`${current.recorded_date}T00:00:00Z`);
    const end = new Date(`${next.recorded_date}T00:00:00Z`);
    const spanDays = Math.max(Math.round((end - start) / 86400000), 1);
    for (let d = 0; d < spanDays; d += 1) {
      const date = new Date(start.getTime() + d * 86400000);
      const ratio = d / spanDays;
      const value = Number(current.salinity_gpl) + (Number(next.salinity_gpl) - Number(current.salinity_gpl)) * ratio;
      output.push({
        station: current.station,
        province: current.province,
        latitude: current.latitude,
        longitude: current.longitude,
        recorded_date: date.toISOString().slice(0, 10),
        salinity_gpl: Number(value.toFixed(3)),
        interpolated: d !== 0
      });
    }
  }
  output.push({ ...sorted[sorted.length - 1], interpolated: false });
  return output;
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
  // Proxy formula v1: coefficients below are operational starting points for hackathon demo.
  // Open-Meteo/NASA provide features; real salinity measurements are the missing labels
  // needed to fit these coefficients instead of hand-tuning them.
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

function cultivationRecommendations(value, season) {
  const numeric = Number(value);
  const safeValue = Number.isFinite(numeric) ? numeric : 0;
  const zone = CULTIVATION_CATALOG.zones.find(item => safeValue >= item.min && safeValue < item.max) ||
    CULTIVATION_CATALOG.zones[CULTIVATION_CATALOG.zones.length - 1];
  const recommendedSpecies = zone.species
    .map(id => {
      const item = CULTIVATION_CATALOG.species[id];
      if (!item) return null;
      const [min, max] = item.range;
      const inRange = safeValue >= min && safeValue <= max;
      const distance = inRange ? 0 : Math.min(Math.abs(safeValue - min), Math.abs(safeValue - max));
      const score = Math.max(52, Math.round(96 - distance * 12 - (inRange ? 0 : 14)));
      const fit = inRange ? 'high' : 'watch';
      return {
        id,
        name: item.name,
        score,
        fit,
        salinity_range_gpl: `${min}-${max} g/L`,
        residue: item.residue,
        reason: item.reason
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  return {
    zone_id: zone.id,
    zone_name: zone.name,
    model: zone.model,
    crop_options: zone.crops,
    recommended_species: recommendedSpecies,
    primary_species: recommendedSpecies[0] || null,
    rationale: `Độ mặn/proxy ${safeValue.toFixed(1)} g/L nằm trong ${zone.name}; hệ thống ưu tiên mô hình ${zone.model}.`,
    engine: 'rule_based_v1',
    note: 'Khuyến nghị ban đầu theo ngưỡng độ mặn; cần HTX/nông học xác nhận theo ao, đất, nước và thị trường địa phương.'
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
 * GET /api/salinity/ml/dataset-summary
 * Shows the real salinity labels available for calibration/training.
 */
router.get('/ml/dataset-summary', auth, async (req, res) => {
  try {
    const db = await getDb();
    const province = req.query.province ? normalizeProvince(req.query.province) : null;
    res.json({
      label_dataset: salinityLabelSummary(db, province),
      label_meaning: 'Historical station salinity measurements. This is the ML label/answer, not an IoT live reading.',
      feature_sources: ['open-meteo:river_discharge', 'nasa-power:PRECTOTCORR'],
      preprocessing_plan: [
        'Group labels by station and date.',
        'Resample sparse station measurements to daily rows.',
        'Apply linear interpolation only between known station measurements.',
        'Join daily Open-Meteo river discharge and NASA POWER rainfall by date/location.',
        'Train/calibrate after enough station labels are available; rule_based_v1 remains the production decision engine for this demo.'
      ],
      model_status: 'labels_available_for_calibration',
      engine_in_use: 'rule_based_v1'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/salinity/ml/training-set
 * Returns label rows, optionally daily-interpolated, ready to join with NASA/Open-Meteo features.
 */
router.get('/ml/training-set', auth, async (req, res) => {
  try {
    const db = await getDb();
    const province = req.query.province ? normalizeProvince(req.query.province) : null;
    const station = req.query.station ? String(req.query.station).trim() : null;
    const params = [];
    const where = [];
    if (province) {
      where.push('province = ?');
      params.push(province);
    }
    if (station) {
      where.push('LOWER(station) = LOWER(?)');
      params.push(station);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = queryObjects(db, `
      SELECT station, province, latitude, longitude, recorded_date, salinity_gpl, source
      FROM salinity_labels
      ${clause}
      ORDER BY station, recorded_date
    `, params);
    const interpolate = String(req.query.interpolate || '').toLowerCase() === 'true';
    const grouped = rows.reduce((acc, row) => {
      const key = `${row.province}|${row.station}`;
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});
    const data = interpolate
      ? Object.values(grouped).flatMap(group => interpolateDailyLabels(group))
      : rows;
    res.json({
      data,
      count: data.length,
      raw_label_count: rows.length,
      interpolation: interpolate ? 'linear_daily_between_station_measurements' : 'none',
      join_keys_for_features: ['province', 'station', 'latitude', 'longitude', 'recorded_date'],
      label_column: 'salinity_gpl',
      feature_sources_to_join: ['open-meteo:river_discharge', 'nasa-power:PRECTOTCORR'],
      warning: 'Interpolated labels are for model preprocessing/calibration only, not direct field measurements.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ml/model', auth, async (_req, res) => {
  try {
    const model = loadSalinityModel();
    if (!model) return res.status(404).json({ error: 'ML model artifact not found. Train the model first.' });
    res.json({
      model_type: model.model_type,
      trained_at: model.trained_at,
      feature_names: model.feature_names,
      alpha: model.alpha,
      train_metrics: model.train_metrics,
      test_metrics: model.test_metrics,
      training_rows: model.training_rows,
      test_rows: model.test_rows,
      feature_sources: model.feature_sources,
      label_source: model.label_source
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ml-predict', auth, async (req, res) => {
  try {
    const db = await getDb();
    const province = req.query.province || req.user.province;
    if (!province) return res.status(400).json({ error: 'province required' });
    const model = loadSalinityModel();
    if (!model) return res.status(404).json({ error: 'ML model artifact not found. Train the model first.' });
    const location = resolveMlLocation(db, province, req.query.station || null);
    const labelDataset = salinityLabelSummary(db, normalizeProvince(province));
    const globalLabelDataset = salinityLabelSummary(db, null);
    const baselineFallback = Number(labelDataset.avg_salinity_gpl || globalLabelDataset.avg_salinity_gpl || 0);
    const stationAverage = req.query.station
      ? queryObjects(
          db,
          `SELECT ROUND(AVG(salinity_gpl), 4) AS avg_salinity_gpl
           FROM salinity_labels
           WHERE province = ? AND LOWER(station) = LOWER(?)`,
          [normalizeProvince(province), req.query.station]
        )[0]?.avg_salinity_gpl
      : null;
    const baselines = {
      province_label_avg_salinity: baselineFallback,
      station_label_avg_salinity: Number(stationAverage || baselineFallback)
    };
    const featureContext = await buildLatestMlFeatureContext(location, baselines, new Date());
    const predictedSalinity = predictWithSalinityModel(model, featureContext.featureMap);
    const decision = decisionFromSalinity(predictedSalinity);
    const cultivation = cultivationRecommendations(predictedSalinity, decision.recommended_season);
    res.json({
      province: normalizeProvince(province),
      station: req.query.station || null,
      location,
      engine: model.model_type,
      predicted_salinity_gpl: predictedSalinity,
      recommended_season: decision.recommended_season,
      advice: decision.advice,
      threshold_tier: decision.threshold_tier,
      cultivation_recommendations: cultivation,
      top_species: cultivation.recommended_species,
      target_date: featureContext.target_date,
      features_used: featureContext.featureMap,
      sources: featureContext.sources,
      data_basis: 'ml_prediction',
      model_metrics: {
        train: model.train_metrics,
        test: model.test_metrics
      },
      label_dataset: {
        source: labelDataset.source,
        labels: labelDataset.labels,
        stations: labelDataset.stations,
        first_date: labelDataset.first_date,
        last_date: labelDataset.last_date
      },
      warning: Number(labelDataset.labels) > 0
        ? null
        : 'Province has no direct salinity labels in the current training set; prediction uses regional open-data features plus global historical baseline.',
      disclaimer: 'ML baseline du doan do man tu du lieu mo va nhan tram lich su; can tiep tuc hieu chinh khi co them label hien truong.'
    });
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
      const cultivation = cultivationRecommendations(proxy.estimated_salinity_gpl, decision.recommended_season);
      const labelDataset = salinityLabelSummary(db, provinceKey);
      return res.json({
        province: proxy.key,
        recommended_season: decision.recommended_season,
        advice: decision.advice,
        cultivation_recommendations: cultivation,
        top_species: cultivation.recommended_species,
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
        label_dataset: {
          source: labelDataset.source,
          labels: labelDataset.labels,
          stations: labelDataset.stations,
          first_date: labelDataset.first_date,
          last_date: labelDataset.last_date
        },
        ml_status: Number(labelDataset.labels) > 0 ? 'labels_available_for_calibration' : 'labels_needed',
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
    const cultivation = cultivationRecommendations(avgRecent, decision.recommended_season);
    const labelDataset = salinityLabelSummary(db, provinceKey);
    res.json({
      province: provinceKey,
      recommended_season: decision.recommended_season,
      advice: decision.advice,
      cultivation_recommendations: cultivation,
      top_species: cultivation.recommended_species,
      avg_gpl_or_proxy_value: avgRecent,
      threshold_tier: decision.threshold_tier,
      engine: 'rule_based_v1',
      ml_roadmap: ML_ROADMAP,
      data_basis: 'seed_demo',
      sources: ['salinity_readings:seed_demo'],
      based_on_readings: readings.length,
      label_dataset: {
        source: labelDataset.source,
        labels: labelDataset.labels,
        stations: labelDataset.stations,
        first_date: labelDataset.first_date,
        last_date: labelDataset.last_date
      },
      ml_status: Number(labelDataset.labels) > 0 ? 'labels_available_for_calibration' : 'labels_needed'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
