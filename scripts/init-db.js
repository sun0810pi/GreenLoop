const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'greenloop.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'farmer',
  province TEXT NOT NULL DEFAULT 'ca-mau',
  farm_ha REAL NOT NULL DEFAULT 0,
  points_balance INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pickups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  biomass_type TEXT NOT NULL,
  quantity_kg REAL NOT NULL,
  location TEXT,
  province TEXT,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  htx_code TEXT,
  biochar_yield_kg REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS carbon_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pickup_id TEXT REFERENCES pickups(id) ON DELETE SET NULL,
  season TEXT NOT NULL,
  biochar_kg REAL NOT NULL,
  co2e_tonnes REAL NOT NULL,
  scu_units REAL NOT NULL,
  status TEXT NOT NULL,
  passport_hash TEXT,
  mrv_trail TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS redemptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  item TEXT NOT NULL,
  voucher_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS salinity_readings (
  id TEXT PRIMARY KEY,
  station TEXT NOT NULL,
  river TEXT,
  province TEXT NOT NULL,
  value_gpl REAL NOT NULL,
  threshold_gpl REAL NOT NULL DEFAULT 5,
  alert INTEGER NOT NULL DEFAULT 0,
  measured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pickups_user ON pickups(user_id);
CREATE INDEX IF NOT EXISTS idx_carbon_user ON carbon_records(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
`);

const existing = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
if (existing > 0) {
  console.log(`SQLite DB already initialized: ${DB_FILE}`);
  process.exit(0);
}

const insertUser = db.prepare(`
  INSERT INTO users (id, name, phone, email, role, province, farm_ha, points_balance, password_hash, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertPickup = db.prepare(`
  INSERT INTO pickups (id, user_id, biomass_type, quantity_kg, location, province, scheduled_at, status, notes, htx_code, biochar_yield_kg, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertCarbon = db.prepare(`
  INSERT INTO carbon_records (id, user_id, pickup_id, season, biochar_kg, co2e_tonnes, scu_units, status, passport_hash, mrv_trail, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertNotification = db.prepare(`
  INSERT INTO notifications (id, user_id, type, title, body, read, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertSalinity = db.prepare(`
  INSERT INTO salinity_readings (id, station, river, province, value_gpl, threshold_gpl, alert, measured_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const farmerId = 'usr_farmer_demo';
const htxId = 'usr_htx_demo';
const adminId = 'usr_admin_demo';
const now = new Date().toISOString();

db.exec('BEGIN');
try {
  insertUser.run(farmerId, 'Nguyen Van Thanh', '0987654321', 'farmer@greenloop.vn', 'farmer', 'ca-mau', 3.2, 1320, hashPassword('password123'), now);
  insertUser.run(htxId, 'Ca Mau HTX Staff', '0900000001', 'htx@greenloop.vn', 'htx', 'ca-mau', 0, 0, hashPassword('password123'), now);
  insertUser.run(adminId, 'GreenLoop Admin', '0900000000', 'admin@greenloop.vn', 'admin', 'ca-mau', 0, 0, hashPassword('password123'), now);

  const pickup1 = id('pick');
  const pickup2 = id('pick');
  const pickup3 = id('pick');
  insertPickup.run(pickup1, farmerId, 'rice_straw', 620, 'camau_central', 'ca-mau', daysAgo(30), 'processed', 'Dry straw stacked near Field A', 'HTX-CM-01', 217, daysAgo(32), daysAgo(28));
  insertPickup.run(pickup2, farmerId, 'pond_sludge', 840, 'camau_central', 'ca-mau', daysAgo(18), 'collected', 'Pond B drainage gate access', 'HTX-CM-01', 0, daysAgo(20), daysAgo(18));
  insertPickup.run(pickup3, farmerId, 'rice_husk', 750, 'baclieu_north', 'ca-mau', daysAgo(8), 'confirmed', 'Bagged husk at storage shed', 'HTX-CM-01', 0, daysAgo(9), daysAgo(8));

  insertCarbon.run(
    id('carb'),
    farmerId,
    pickup1,
    'wet_rice',
    217,
    0.543,
    0.543,
    'issued',
    hash(`${pickup1}:217:0.543`),
    JSON.stringify([
      { tier: 1, action: 'HTX verified feedstock custody at collection hub' },
      { tier: 2, action: 'Pyrolysis partner recorded biochar yield' },
      { tier: 3, action: 'Carbon engine calculated VM0044 credit estimate' }
    ]),
    daysAgo(28)
  );
  insertCarbon.run(
    id('carb'),
    farmerId,
    null,
    'dry_shrimp',
    95,
    0.143,
    0.143,
    'verified',
    hash('shrimp-baseline'),
    JSON.stringify([
      { tier: 1, action: 'HTX logged shrimp pond sludge baseline' },
      { tier: 2, action: 'Partner lab validated moisture and ash profile' }
    ]),
    daysAgo(90)
  );

  insertNotification.run(id('noti'), farmerId, 'alert', 'Salt water near your field', 'Canal N-03 reads 3.8 g/L - careful with rice', 0, daysAgo(1));
  insertNotification.run(id('noti'), farmerId, 'success', 'Payment received', '1,250,000 VND for batch #GL-003 - sent to Agribank', 0, daysAgo(2));
  insertNotification.run(id('noti'), farmerId, 'info', 'Pickup confirmed', 'HTX truck comes tomorrow · Ca Mau Central Hub', 1, daysAgo(3));

  insertSalinity.run('sal_ca_mau', 'Canal N-03', 'Ca Mau Canal', 'ca-mau', 3.8, 5, 0, now);
  insertSalinity.run('sal_bac_lieu', 'Bac Lieu East', 'Ganh Hao', 'bac-lieu', 5.4, 5, 1, now);
  insertSalinity.run('sal_soc_trang', 'Soc Trang S-02', 'Hau River', 'soc-trang', 1.2, 5, 0, now);

  db.exec('COMMIT');
  console.log(`SQLite DB initialized: ${DB_FILE}`);
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
