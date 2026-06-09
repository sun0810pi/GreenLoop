const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'greenloop-local-dev-secret';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'greenloop.sqlite');
const MAX_BODY_BYTES = 1_000_000;
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_ATTEMPTS = 20;
const RATE_BUCKET_CLEANUP_MS = 5 * 60_000;
const BIOCHAR_PRICE_PER_KG_VND = 1250;
const CARBON_CREDIT_PRICE_PER_TONNE_VND = 700_000;

if (process.env.NODE_ENV === 'production' && TOKEN_SECRET === 'greenloop-local-dev-secret') {
  console.warn('WARNING: TOKEN_SECRET is using the local development default in production.');
}

const FEEDSTOCK = {
  rice_straw: { yield: 0.35, co2e: 2.5, pointsPerKg: 0.8, season: 'wet_rice' },
  rice_husk: { yield: 0.32, co2e: 2.4, pointsPerKg: 0.7, season: 'wet_rice' },
  pond_sludge: { yield: 0.18, co2e: 1.5, pointsPerKg: 0.55, season: 'dry_shrimp' },
  shrimp_sludge: { yield: 0.18, co2e: 1.5, pointsPerKg: 0.55, season: 'dry_shrimp' },
  coconut: { yield: 0.4, co2e: 2.2, pointsPerKg: 0.65, season: 'mixed' },
  mixed: { yield: 0.3, co2e: 2.0, pointsPerKg: 0.6, season: 'mixed' }
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) {
  console.error(`Database not found: ${DB_FILE}`);
  console.error('Run: npm run db:init');
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON');

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const rateBuckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}, RATE_BUCKET_CLEANUP_MS).unref();

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function ensureSalinityHistory() {
  const stations = all(`
    SELECT station, river, province, value_gpl, threshold_gpl, alert
    FROM salinity_readings
    WHERE measured_at IN (SELECT MAX(measured_at) FROM salinity_readings GROUP BY station)
  `);
  if (!stations.length) return;
  const distinctDays = one('SELECT COUNT(DISTINCT date(measured_at)) AS n FROM salinity_readings').n;
  if (distinctDays >= 7) return;
  const insert = db.prepare(`
    INSERT INTO salinity_readings (id, station, river, province, value_gpl, threshold_gpl, alert, measured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const today = new Date();
  db.exec('BEGIN');
  try {
    for (let daysBack = 6; daysBack >= 0; daysBack--) {
      const d = new Date(today);
      d.setDate(today.getDate() - daysBack);
      d.setHours(8, 0, 0, 0);
      const dayKey = d.toISOString().slice(0, 10);
      for (const station of stations) {
        const exists = one('SELECT id FROM salinity_readings WHERE station = ? AND date(measured_at) = ? LIMIT 1', station.station, dayKey);
        if (exists) continue;
        const drift = (6 - daysBack) * 0.18;
        const offset = station.station.includes('Bac') ? 0.4 : station.station.includes('Soc') ? -0.25 : 0;
        const value = Math.max(0.2, Number(station.value_gpl || 0) - 0.7 + drift + offset);
        insert.run(id('sal'), station.station, station.river, station.province, Number(value.toFixed(1)), station.threshold_gpl || 5, value >= Number(station.threshold_gpl || 5) ? 1 : 0, d.toISOString());
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

ensureSalinityHistory();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, saved) {
  if (!saved || !saved.includes(':')) return false;
  const [salt] = saved.split(':');
  return crypto.timingSafeEqual(Buffer.from(hashPassword(password, salt)), Buffer.from(saved));
}

function signToken(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, exp: Date.now() + 1000 * 60 * 60 * 24 * 14 })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const sep = token.lastIndexOf('.');
  const payload = token.slice(0, sep);
  const sig = token.slice(sep + 1);
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data.userId : null;
  } catch {
    return null;
  }
}

function publicUser(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  return safe;
}

function send(res, status, data, headers = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    ...headers
  });
  res.end(body);
}

function error(res, status, message) {
  send(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new ApiError(413, 'Payload too large'));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks, totalBytes).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new ApiError(400, 'Invalid JSON body')); }
    });
    req.on('error', err => {
      if (!tooLarge) reject(err);
    });
  });
}

function clientKey(req, scope) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const ip = forwardedIp ? forwardedIp.split(',')[0].trim() : req.socket.remoteAddress || 'local';
  return `${scope}:${ip || 'local'}`;
}

function rateLimit(req, scope, max = AUTH_MAX_ATTEMPTS, windowMs = AUTH_WINDOW_MS) {
  const now = Date.now();
  const key = clientKey(req, scope);
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > max) throw new ApiError(429, 'Too many requests. Please try again shortly.');
}

function cleanString(value, max = 160) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

function cleanOptionalEmail(value) {
  const email = cleanString(value, 160).toLowerCase();
  if (!email) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'Invalid email address');
  return email;
}

function cleanLimit(value, fallback = 50, max = 100) {
  const n = Number(value || fallback);
  return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback;
}

function one(sql, ...params) {
  return db.prepare(sql).get(...params);
}

function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

function getUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const userId = readToken(token);
  return userId ? one('SELECT * FROM users WHERE id = ?', userId) : null;
}

function requireUser(req, res) {
  const user = getUser(req);
  if (!user) {
    error(res, 401, 'Your session expired or is missing a token');
    return null;
  }
  return user;
}

function canManage(user) {
  return user && ['htx', 'admin'].includes(user.role);
}

function pickupByIdForUser(idValue, user) {
  if (canManage(user)) return one('SELECT p.*, u.name AS farmer_name, u.phone AS farmer_phone FROM pickups p JOIN users u ON u.id = p.user_id WHERE p.id = ?', idValue);
  return one('SELECT p.*, u.name AS farmer_name, u.phone AS farmer_phone FROM pickups p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.user_id = ?', idValue, user.id);
}

function addNotification(userId, type, title, body) {
  run(
    'INSERT INTO notifications (id, user_id, type, title, body, read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    id('noti'), userId, type, title, body, new Date().toISOString()
  );
}

function makeCarbonRecord(pickup) {
  const factor = FEEDSTOCK[pickup.biomass_type] || FEEDSTOCK.mixed;
  const biocharKg = Number(pickup.biochar_yield_kg || Math.round(Number(pickup.quantity_kg || 0) * factor.yield));
  const co2e = Number(((biocharKg / 1000) * factor.co2e).toFixed(3));
  const recordId = id('carb');
  const now = new Date().toISOString();
  const trail = [
    { tier: 1, action: 'HTX verified feedstock custody at collection hub' },
    { tier: 2, action: 'Pyrolysis partner recorded biochar yield' },
    { tier: 3, action: 'Carbon engine calculated VM0044 credit estimate' }
  ];

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = one('SELECT id FROM carbon_records WHERE pickup_id = ?', pickup.id);
    if (existing) {
      db.exec('COMMIT');
      return;
    }
    run('UPDATE pickups SET biochar_yield_kg = ?, updated_at = ? WHERE id = ?', biocharKg, now, pickup.id);
    run(
      `INSERT INTO carbon_records
        (id, user_id, pickup_id, season, biochar_kg, co2e_tonnes, scu_units, status, passport_hash, mrv_trail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      recordId,
      pickup.user_id,
      pickup.id,
      factor.season,
      biocharKg,
      co2e,
      co2e,
      'verified',
      crypto.createHash('sha256').update(`${pickup.id}:${biocharKg}:${co2e}`).digest('hex'),
      JSON.stringify(trail),
      now
    );
    run('UPDATE users SET points_balance = points_balance + ? WHERE id = ?', Math.round(Number(pickup.quantity_kg || 0) * factor.pointsPerKg), pickup.user_id);
    addNotification(pickup.user_id, 'success', 'Carbon record created', `${biocharKg} kg biochar added to your Carbon Passport`);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

function ensureCarbonForPickup(pickup) {
  makeCarbonRecord(pickup);
}

function syncPickupLifecycle(user) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const params = [startOfToday.toISOString()];
  let sql = `
    SELECT * FROM pickups
    WHERE status IN ('pending', 'confirmed', 'collected')
      AND datetime(scheduled_at) < datetime(?)
  `;
  if (user && !canManage(user)) {
    sql += ' AND user_id = ?';
    params.push(user.id);
  }
  const overdue = all(sql, ...params);
  overdue.forEach(pickup => {
    const factor = FEEDSTOCK[pickup.biomass_type] || FEEDSTOCK.mixed;
    const biocharKg = Number(pickup.biochar_yield_kg || Math.round(Number(pickup.quantity_kg || 0) * factor.yield));
    const result = run(
      `UPDATE pickups
       SET status = ?, biochar_yield_kg = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'confirmed', 'collected')`,
      'processed',
      biocharKg,
      new Date().toISOString(),
      pickup.id
    );
    if (!result.changes) return;
    ensureCarbonForPickup({ ...pickup, status: 'processed', biochar_yield_kg: biocharKg });
    addNotification(pickup.user_id, 'success', 'Pickup completed', `${Math.round(pickup.quantity_kg)} kg biomass has been completed and added to your passport.`);
  });
  return overdue.length;
}

function parseCarbon(row) {
  if (!row) return row;
  return {
    ...row,
    mrv_trail: row.mrv_trail ? JSON.parse(row.mrv_trail) : []
  };
}

async function handleApi(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;

  if (method === 'OPTIONS') return send(res, 204);
  if (pathname === '/api/health') {
    return send(res, 200, { ok: true, service: 'greenloop-backend' });
  }

  if (method === 'POST' && pathname === '/api/auth/register') {
    rateLimit(req, 'auth-register', 10);
    const body = await readBody(req);
    const phone = cleanString(body.phone, 40);
    const email = cleanOptionalEmail(body.email);
    if (!body.name || !phone || !body.password) return error(res, 400, 'Name, phone number and password are required');
    const exists = one('SELECT id FROM users WHERE phone = ? OR (? != ? AND email = ?)', phone, email, '', email);
    if (exists) return error(res, 409, 'Phone number or email is already in use');

    const user = {
      id: id('usr'),
      name: cleanString(body.name, 120),
      phone,
      email,
      role: 'farmer',
      province: cleanString(body.province || 'ca-mau', 40),
      farm_ha: Number(body.farm_ha || 0),
      points_balance: 250,
      password_hash: hashPassword(body.password),
      created_at: new Date().toISOString()
    };
    run(
      `INSERT INTO users (id, name, phone, email, role, province, farm_ha, points_balance, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id, user.name, user.phone, user.email, user.role, user.province, user.farm_ha, user.points_balance, user.password_hash, user.created_at
    );
    addNotification(user.id, 'success', 'Welcome to GreenLoop', 'Your Carbon Farmer Passport is ready.');
    return send(res, 201, { token: signToken(user.id), user: publicUser(user) });
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    rateLimit(req, 'auth-login');
    const body = await readBody(req);
    const login = cleanString(body.phone || body.email, 160).toLowerCase();
    const user = one('SELECT * FROM users WHERE phone = ? OR lower(email) = ?', login, login);
    if (!user || !verifyPassword(body.password || '', user.password_hash)) return error(res, 401, 'Wrong phone/email or password');
    return send(res, 200, { token: signToken(user.id), user: publicUser(user) });
  }

  if (method === 'GET' && pathname === '/api/salinity') {
    const rows = all('SELECT * FROM salinity_readings ORDER BY measured_at DESC');
    const max = rows.length ? Math.max(...rows.map(s => Number(s.value_gpl) || 0)) : 0;
    const trendRows = all(`
      SELECT date(measured_at) AS day, AVG(value_gpl) AS value_gpl
      FROM salinity_readings
      GROUP BY date(measured_at)
      ORDER BY date(measured_at) DESC
      LIMIT 7
    `).reverse();
    const trend = trendRows.map(r => ({
      date: new Date(`${r.day}T00:00:00.000Z`).toISOString(),
      value_gpl: Number(Number(r.value_gpl || 0).toFixed(1))
    }));
    const summary = {
      max_value_gpl: max,
      alert_count: rows.filter(s => Number(s.alert) || s.value_gpl >= s.threshold_gpl).length,
      recommendation: max >= 5 ? 'Salinity is above shrimp-season threshold. Prepare water gates and stop rice intake.' : max >= 2.5 ? 'Salinity is rising. Monitor the next 72 hours and prepare transition plan.' : 'Salinity is safe for rice cultivation.',
      trend
    };
    return send(res, 200, { data: rows, summary });
  }

  if (method === 'GET' && pathname === '/api/salinity/season-advice') {
    const province = cleanString(url.searchParams.get('province') || 'ca-mau', 40);
    const reading = one('SELECT * FROM salinity_readings WHERE province = ? ORDER BY measured_at DESC LIMIT 1', province)
      || one('SELECT * FROM salinity_readings ORDER BY measured_at DESC LIMIT 1');
    const value = Number(reading?.value_gpl || 0);
    const recommended = value >= 5 ? 'shrimp' : value >= 2.5 ? 'transition' : 'rice';
    const crossing = new Date();
    crossing.setDate(crossing.getDate() + (recommended === 'rice' ? 12 : recommended === 'transition' ? 6 : 1));
    const optimal = new Date(crossing);
    optimal.setDate(crossing.getDate() - 5);
    const advice = recommended === 'shrimp'
      ? 'Salinity has exceeded 5 g/L. Switch to shrimp season and close rice-field water gates.'
      : recommended === 'transition'
        ? 'Salinity is rising. Prepare to switch season within the next 3-5 days.'
        : 'Salinity is safe for rice season. Continue daily monitoring.';
    return send(res, 200, {
      province,
      station: reading?.station,
      value_gpl: value,
      recommended_season: recommended,
      advice,
      forecast_crossing_date: crossing.toISOString(),
      optimal_switch_date: optimal.toISOString(),
      threshold_gpl: reading?.threshold_gpl || 5
    });
  }

  const user = requireUser(req, res);
  if (!user) return;
  if (['/api/dashboard', '/api/pickups', '/api/carbon', '/api/carbon/summary'].some(p => pathname === p || pathname.startsWith(`${p}/`))) {
    syncPickupLifecycle(user);
  }

  if (pathname === '/api/auth/me' && method === 'GET') return send(res, 200, { user: publicUser(user) });

  if (pathname === '/api/dashboard' && method === 'GET') {
    const season = url.searchParams.get('season') || 'rice';
    const now = new Date();
    const year = now.getFullYear();
    const monthStart = new Date(year, now.getMonth(), 1).toISOString();
    const nextHarvest = new Date(now);
    nextHarvest.setDate(now.getDate() + (season === 'shrimp' ? 30 : 32));
    const soilTest = new Date(now);
    soilTest.setDate(now.getDate() + 14);

    const processed = all(
      `SELECT * FROM pickups
       WHERE user_id = ? AND status = 'processed'
       ORDER BY datetime(scheduled_at) DESC`,
      user.id
    );
    const active = all(
      `SELECT * FROM pickups
       WHERE user_id = ? AND status IN ('pending', 'confirmed', 'collected')
       ORDER BY datetime(scheduled_at) ASC`,
      user.id
    );
    const carbon = one('SELECT COALESCE(SUM(co2e_tonnes), 0) AS co2e, COALESCE(SUM(biochar_kg), 0) AS biochar FROM carbon_records WHERE user_id = ?', user.id);
    const processedAt = p => new Date(p.updated_at || p.scheduled_at);
    const monthProcessed = processed.filter(p => processedAt(p) >= new Date(monthStart));
    const revenueFor = p => {
      const factor = FEEDSTOCK[p.biomass_type] || FEEDSTOCK.mixed;
      return Math.round(
        (Number(p.biochar_yield_kg || 0) * BIOCHAR_PRICE_PER_KG_VND)
        + (Number(p.biochar_yield_kg || 0) / 1000 * factor.co2e * CARBON_CREDIT_PRICE_PER_TONNE_VND)
      );
    };
    const earnedThisMonth = monthProcessed.reduce((sum, p) => sum + revenueFor(p), 0);
    const pendingPayment = processed.filter(p => processedAt(p) >= new Date(monthStart)).reduce((sum, p) => sum + Math.round(revenueFor(p) * 0.35), 0);
    const waitingKg = active.reduce((sum, p) => sum + Number(p.quantity_kg || 0), 0);

    const monthly = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(year, now.getMonth() - i, 1);
      const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const rows = processed.filter(p => {
        const processedDate = processedAt(p);
        return processedDate >= d && processedDate < next;
      });
      const riceKg = rows.filter(p => ['rice_straw', 'rice_husk'].includes(p.biomass_type)).reduce((sum, p) => sum + Number(p.quantity_kg || 0), 0);
      const sludgeKg = rows.filter(p => ['pond_sludge', 'shrimp_sludge'].includes(p.biomass_type)).reduce((sum, p) => sum + Number(p.quantity_kg || 0), 0);
      monthly.push({
        month: d.toISOString(),
        label: d.toLocaleDateString('en-US', { month: 'short' }),
        rice_kg: riceKg,
        sludge_kg: sludgeKg
      });
    }

    const strawRevenue = processed.filter(p => ['rice_straw', 'rice_husk'].includes(p.biomass_type)).reduce((sum, p) => sum + revenueFor(p), 0);
    const sludgeRevenue = processed.filter(p => ['pond_sludge', 'shrimp_sludge'].includes(p.biomass_type)).reduce((sum, p) => sum + revenueFor(p), 0);
    const carbonBonus = Math.round(Number(carbon.co2e || 0) * CARBON_CREDIT_PRICE_PER_TONNE_VND);
    const totalRevenue = strawRevenue + sludgeRevenue + carbonBonus;

    return send(res, 200, {
      generated_at: now.toISOString(),
      season,
      stats: {
        earned_this_month_vnd: earnedThisMonth,
        pending_payment_vnd: pendingPayment,
        waiting_kg: waitingKg,
        days_until_next_harvest: Math.max(0, Math.ceil((nextHarvest - now) / 86400000)),
        processed_pickups: processed.length,
        active_pickups: active.length
      },
      earnings: {
        goal_vnd: 25000000,
        straw_vnd: strawRevenue,
        sludge_vnd: sludgeRevenue,
        carbon_bonus_vnd: carbonBonus,
        total_vnd: totalRevenue
      },
      monthly,
      field: season === 'shrimp' ? {
        title: 'My pond - Pond B (shrimp)',
        badge: 'Water quality good',
        score: 'Good',
        label: 'pond',
        size: '0.8 hectares',
        metrics: [
          { label: 'Salinity (g/L)', value: '4.2 - optimal', width: 65, tone: 'a' },
          { label: 'Dissolved oxygen', value: '5.2 mg/L - good', width: 72, tone: 'g' },
          { label: 'pH', value: '7.8 - balanced', width: 64, tone: 'e' }
        ],
        note_title: 'Pond status',
        note: 'Shrimp growing well. Sludge biochar from last cycle improved pond DO by 12%. Expected harvest in 30 days.',
        next_check: nextHarvest.toISOString()
      } : {
        title: 'My field - Plot A (rice)',
        badge: 'Soil getting better',
        score: 'Healthy',
        label: 'soil',
        size: `${Number(user.farm_ha || 3.2).toLocaleString('vi-VN')} hectares`,
        metrics: [
          { label: 'Organic matter', value: '2.8% - good', width: 56, tone: 'g' },
          { label: 'Moisture', value: '72% - good', width: 72, tone: 'a' },
          { label: 'pH (acidity)', value: '6.4 - balanced', width: 64, tone: 'e' }
        ],
        note_title: 'What changed',
        note: 'After putting biochar on the field for 2 seasons, the soil holds 18% more water and rice grew stronger.',
        next_check: soilTest.toISOString()
      }
    });
  }

  if (pathname === '/api/auth/me' && method === 'PUT') {
    const body = await readBody(req);
    const next = {
      name: body.name !== undefined ? cleanString(body.name, 120) : user.name,
      province: body.province !== undefined ? cleanString(body.province, 40) : user.province,
      phone: body.phone !== undefined ? cleanString(body.phone, 40) : user.phone,
      email: body.email !== undefined ? cleanOptionalEmail(body.email) : user.email,
      farm_ha: body.farm_ha !== undefined ? Number(body.farm_ha || 0) : user.farm_ha
    };
    if (!next.name || !next.phone) return error(res, 400, 'Name and phone are required');
    const conflict = one(
      'SELECT id FROM users WHERE id != ? AND (phone = ? OR (? != ? AND lower(email) = ?))',
      user.id,
      next.phone,
      next.email,
      '',
      next.email
    );
    if (conflict) return error(res, 409, 'Phone number or email is already in use');
    run('UPDATE users SET name = ?, province = ?, phone = ?, email = ?, farm_ha = ? WHERE id = ?', next.name, next.province, next.phone, next.email, next.farm_ha, user.id);
    return send(res, 200, { user: publicUser(one('SELECT * FROM users WHERE id = ?', user.id)) });
  }

  if (pathname === '/api/pickups' && method === 'GET') {
    const limit = cleanLimit(url.searchParams.get('limit'), 50);
    const status = url.searchParams.get('status');
    const statuses = ['pending', 'confirmed', 'collected', 'processed', 'cancelled'];
    if (status && status !== 'all' && !statuses.includes(status)) return error(res, 400, 'Invalid status');
    const params = [];
    let sql = 'SELECT p.*, u.name AS farmer_name, u.phone AS farmer_phone FROM pickups p JOIN users u ON u.id = p.user_id';
    const where = [];
    if (!canManage(user)) { where.push('p.user_id = ?'); params.push(user.id); }
    if (status && status !== 'all') { where.push('p.status = ?'); params.push(status); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY datetime(p.created_at) DESC LIMIT ?';
    params.push(limit);
    return send(res, 200, { data: all(sql, ...params) });
  }

  if (pathname === '/api/pickups' && method === 'POST') {
    const body = await readBody(req);
    const qty = Number(body.quantity_kg || 0);
    const biomassType = cleanString(body.biomass_type, 40);
    const scheduled = new Date(body.scheduled_at);
    if (!FEEDSTOCK[biomassType] || qty < 500 || Number.isNaN(scheduled.getTime())) return error(res, 400, 'Biomass type, at least 500 kg, and pickup date are required');
    if (scheduled <= new Date()) return error(res, 400, 'Pickup date must be in the future');
    const pickupId = id('pick');
    const now = new Date().toISOString();
    run(
      `INSERT INTO pickups
       (id, user_id, biomass_type, quantity_kg, location, province, scheduled_at, status, notes, htx_code, biochar_yield_kg, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?)`,
      pickupId,
      user.id,
      biomassType,
      qty,
      cleanString(body.location, 180),
      cleanString(body.province || user.province || 'ca-mau', 40),
      scheduled.toISOString(),
      cleanString(body.notes, 500),
      cleanString(body.htx_code || 'HTX-CM-01', 40),
      now,
      now
    );
    addNotification(user.id, 'info', 'Pickup requested', `HTX received your ${qty} kg biomass booking.`);
    return send(res, 201, pickupByIdForUser(pickupId, user));
  }

  const pickupDetail = pathname.match(/^\/api\/pickups\/([^/]+)$/);
  if (pickupDetail && method === 'GET') {
    const pickup = pickupByIdForUser(pickupDetail[1], user);
    if (!pickup) return error(res, 404, 'Pickup was not found');
    return send(res, 200, { data: pickup });
  }

  if (pickupDetail && method === 'DELETE') {
    const pickup = pickupByIdForUser(pickupDetail[1], user);
    if (!pickup) return error(res, 404, 'Pickup was not found');
    if (!canManage(user) && !['pending', 'confirmed'].includes(pickup.status)) return error(res, 403, 'Only pending or confirmed pickups can be cancelled');
    run('UPDATE pickups SET status = ?, updated_at = ? WHERE id = ?', 'cancelled', new Date().toISOString(), pickup.id);
    addNotification(pickup.user_id, 'warning', 'Pickup cancelled', 'Your biomass pickup has been cancelled.');
    return send(res, 200, { data: pickupByIdForUser(pickup.id, user) });
  }

  const pickupStatus = pathname.match(/^\/api\/pickups\/([^/]+)\/status$/);
  if (pickupStatus && method === 'PATCH') {
    if (!canManage(user)) return error(res, 403, 'Only HTX/admin users can update status');
    const body = await readBody(req);
    const statuses = ['pending', 'confirmed', 'collected', 'processed', 'cancelled'];
    if (!statuses.includes(body.status)) return error(res, 400, 'Invalid status');
    const pickup = one('SELECT * FROM pickups WHERE id = ?', pickupStatus[1]);
    if (!pickup) return error(res, 404, 'Pickup was not found');
    const yieldKg = body.biochar_yield_kg !== undefined ? Number(body.biochar_yield_kg || 0) : pickup.biochar_yield_kg;
    if (!Number.isFinite(yieldKg) || yieldKg < 0 || yieldKg > 1000000) return error(res, 400, 'Invalid biochar weight');
    run('UPDATE pickups SET status = ?, biochar_yield_kg = ?, updated_at = ? WHERE id = ?', body.status, yieldKg, new Date().toISOString(), pickup.id);
    const updated = one('SELECT * FROM pickups WHERE id = ?', pickup.id);
    if (body.status === 'processed') ensureCarbonForPickup(updated);
    addNotification(pickup.user_id, 'info', 'Pickup status updated', `Your pickup is now ${body.status}.`);
    return send(res, 200, { data: pickupByIdForUser(pickup.id, user) });
  }

  if (pathname === '/api/carbon' && method === 'GET') {
    const limit = cleanLimit(url.searchParams.get('limit'), 50);
    const rows = canManage(user)
      ? all('SELECT * FROM carbon_records ORDER BY datetime(created_at) DESC LIMIT ?', limit)
      : all('SELECT * FROM carbon_records WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT ?', user.id, limit);
    return send(res, 200, { data: rows.map(parseCarbon) });
  }

  if (pathname === '/api/carbon/summary' && method === 'GET') {
    const userFilter = canManage(user) ? { where: '', params: [] } : { where: ' WHERE user_id = ?', params: [user.id] };
    const carbon = one(`SELECT COALESCE(SUM(co2e_tonnes), 0) AS total_co2e_tonnes, COALESCE(SUM(biochar_kg), 0) AS total_biochar_kg FROM carbon_records${userFilter.where}`, ...userFilter.params);
    const totalPickups = one(`SELECT COUNT(*) AS n FROM pickups${userFilter.where}`, ...userFilter.params).n;
    const processedWhere = userFilter.where ? `${userFilter.where} AND status = ?` : ' WHERE status = ?';
    const processedPickups = one(`SELECT COUNT(*) AS n FROM pickups${processedWhere}`, ...userFilter.params, 'processed').n;
    const totalCo2 = Number(carbon.total_co2e_tonnes || 0);
    return send(res, 200, {
      total_co2e_tonnes: Number(totalCo2.toFixed(3)),
      total_biochar_kg: Number(Number(carbon.total_biochar_kg || 0).toFixed(1)),
      total_pickups: totalPickups,
      processed_pickups: processedPickups,
      points_balance: user.points_balance || 0,
      total_revenue_usd: Number((totalCo2 * 28).toFixed(2))
    });
  }

  const carbonDetail = pathname.match(/^\/api\/carbon\/([^/]+)$/);
  if (carbonDetail && method === 'GET') {
    const row = canManage(user)
      ? one('SELECT * FROM carbon_records WHERE id = ?', carbonDetail[1])
      : one('SELECT * FROM carbon_records WHERE id = ? AND user_id = ?', carbonDetail[1], user.id);
    if (!row) return error(res, 404, 'Carbon record was not found');
    return send(res, 200, { data: parseCarbon(row) });
  }

  if (pathname === '/api/notifications' && method === 'GET') {
    const limit = cleanLimit(url.searchParams.get('limit'), 50, 100);
    const rows = all('SELECT * FROM notifications WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT ?', user.id, limit);
    const unread = one('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', user.id);
    return send(res, 200, { data: rows, unread_count: unread.n || 0 });
  }

  if (pathname === '/api/notifications/read-all' && method === 'PATCH') {
    run('UPDATE notifications SET read = 1 WHERE user_id = ?', user.id);
    return send(res, 200, { ok: true });
  }

  const notificationRead = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (notificationRead && method === 'PATCH') {
    const note = one('SELECT * FROM notifications WHERE id = ? AND user_id = ?', notificationRead[1], user.id);
    if (!note) return error(res, 404, 'Notification was not found');
    run('UPDATE notifications SET read = 1 WHERE id = ?', note.id);
    return send(res, 200, { data: one('SELECT * FROM notifications WHERE id = ?', note.id) });
  }

  if (pathname === '/api/points' && method === 'GET') {
    const fresh = one('SELECT points_balance FROM users WHERE id = ?', user.id);
    return send(res, 200, { balance: fresh.points_balance || 0, currency: 'GLP' });
  }

  if (pathname === '/api/points/redeem' && method === 'POST') {
    const body = await readBody(req);
    const amount = Number(body.amount || 0);
    if (!Number.isFinite(amount) || amount < 100) return error(res, 400, 'Minimum 100 points');
    const voucher = `HTX-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const redemptionId = id('red');
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = run('UPDATE users SET points_balance = points_balance - ? WHERE id = ? AND points_balance >= ?', amount, user.id, amount);
      if (!result.changes) {
        db.exec('ROLLBACK');
        return error(res, 400, 'Not enough points to redeem a voucher');
      }
      run(
        'INSERT INTO redemptions (id, user_id, amount, item, voucher_code, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        redemptionId, user.id, amount, cleanString(body.item || 'fertiliser_voucher', 80), voucher, new Date().toISOString()
      );
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
    addNotification(user.id, 'success', 'Voucher redeemed', `Voucher ${voucher} is ready at your HTX shop.`);
    return send(res, 201, one('SELECT * FROM redemptions WHERE id = ?', redemptionId));
  }

  return error(res, 404, 'Endpoint does not exist');
}

function serveStatic(req, res, url) {
  let filePath = url.pathname === '/' ? path.join(__dirname, 'index.html') : path.join(__dirname, decodeURIComponent(url.pathname));
  const root = path.resolve(__dirname);
  filePath = path.resolve(filePath);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof ApiError) return error(res, err.status, err.message);
    console.error(err);
    return error(res, 500, 'Server error');
  }
});

server.listen(PORT, () => {
  console.log(`GreenLoop backend running at http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_FILE}`);
  console.log('Demo accounts: farmer@greenloop.vn / password123, htx@greenloop.vn / password123, admin@greenloop.vn / password123');
});
