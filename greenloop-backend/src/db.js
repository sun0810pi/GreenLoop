const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

let db;
const DB_PATH = path.join(__dirname, '../greenloop.db.json');

async function getDb() {
  if (db) return db;

  const SQL = await initSqlJs();

  // Load persisted DB if exists
  if (fs.existsSync(DB_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      const buf = Buffer.from(saved.data);
      db = new SQL.Database(buf);
    } catch {
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  initSchema();
  return db;
}

function saveDb() {
  if (!db) return;
  const data = Array.from(db.export());
  fs.writeFileSync(DB_PATH, JSON.stringify({ data }));
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      phone       TEXT UNIQUE NOT NULL,
      email       TEXT UNIQUE,
      password    TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'farmer',  -- farmer | htx | buyer | admin
      province    TEXT,
      farm_ha     REAL DEFAULT 0,
      htx_code    TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      last_login  TEXT
    );

    CREATE TABLE IF NOT EXISTS pickups (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      biomass_type  TEXT NOT NULL,   -- rice_straw | pond_sludge | mixed
      quantity_kg   REAL NOT NULL,
      location      TEXT NOT NULL,
      province      TEXT NOT NULL,
      scheduled_at  TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',  -- pending | confirmed | collected | processed | cancelled
      notes         TEXT,
      htx_code      TEXT,
      biochar_yield_kg REAL,         -- filled after processing
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS salinity_readings (
      id          TEXT PRIMARY KEY,
      station     TEXT NOT NULL,
      province    TEXT NOT NULL,
      river       TEXT,
      value_gpl   REAL NOT NULL,     -- g/L
      recorded_at TEXT NOT NULL,
      source      TEXT DEFAULT 'mrc_api',
      alert       INTEGER DEFAULT 0, -- 1 if > 5 g/L threshold
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS carbon_records (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      pickup_id       TEXT,
      biochar_kg      REAL NOT NULL,
      co2e_tonnes     REAL NOT NULL,   -- biochar_kg * 3.12 / 1000 (EBC factor)
      methodology     TEXT DEFAULT 'Verra VM0044',
      status          TEXT DEFAULT 'pending', -- pending | verified | issued | traded
      passport_hash   TEXT,                   -- blockchain anchor hash
      scu_units       REAL DEFAULT 0,         -- ASEAN Standard Carbon Units
      revenue_usd     REAL DEFAULT 0,
      season          TEXT,                   -- wet_rice | dry_shrimp
      created_at      TEXT DEFAULT (datetime('now')),
      verified_at     TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (pickup_id) REFERENCES pickups(id)
    );

    CREATE TABLE IF NOT EXISTS mrv_logs (
      id            TEXT PRIMARY KEY,
      carbon_id     TEXT NOT NULL,
      tier          INTEGER NOT NULL,  -- 1=field, 2=lab, 3=third-party
      action        TEXT NOT NULL,
      data_hash     TEXT,
      operator      TEXT,
      notes         TEXT,
      logged_at     TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (carbon_id) REFERENCES carbon_records(id)
    );

    CREATE TABLE IF NOT EXISTS points (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      type        TEXT NOT NULL,   -- earned | redeemed
      reason      TEXT,
      ref_id      TEXT,            -- pickup_id or redemption_id
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id          TEXT PRIMARY KEY,
      user_id     TEXT,            -- NULL = broadcast
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      type        TEXT DEFAULT 'info',  -- info | alert | success | warning
      read        INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed demo data if empty
  const userCount = db.exec("SELECT COUNT(*) as c FROM users")[0]?.values[0][0];
  if (userCount === 0) seedDemoData();

  saveDb();
}

function seedDemoData() {
  const { v4: uuidv4 } = require('uuid');
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('demo1234', 10);

  const userId = 'user-demo-001';
  db.run(`INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [userId, 'Nguyen Van Thanh', '0901234567', 'thanh@greenloop.vn',
     hash, 'farmer', 'ca-mau', 3.5, 'HTX-CM-01', new Date().toISOString(), null]);

  const htxId = 'user-htx-001';
  db.run(`INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [htxId, 'Le Thi Mai', '0912345678', 'mai@htx-camau.vn',
     hash, 'htx', 'ca-mau', 0, 'HTX-CM-01', new Date().toISOString(), null]);

  // Demo pickups
  const p1 = uuidv4();
  db.run(`INSERT INTO pickups (id,user_id,biomass_type,quantity_kg,location,province,scheduled_at,status,biochar_yield_kg) VALUES (?,?,?,?,?,?,?,?,?)`,
    [p1, userId, 'rice_straw', 1200, 'Xã Khánh Bình Tây, huyện Trần Văn Thời', 'ca-mau',
     '2025-05-10T07:00:00Z', 'processed', 420]);

  const p2 = uuidv4();
  db.run(`INSERT INTO pickups (id,user_id,biomass_type,quantity_kg,location,province,scheduled_at,status) VALUES (?,?,?,?,?,?,?,?)`,
    [p2, userId, 'pond_sludge', 800, 'Xã Khánh Bình Tây, huyện Trần Văn Thời', 'ca-mau',
     '2025-05-20T07:00:00Z', 'confirmed']);

  // Demo carbon record
  const c1 = uuidv4();
  db.run(`INSERT INTO carbon_records (id,user_id,pickup_id,biochar_kg,co2e_tonnes,status,passport_hash,scu_units,revenue_usd,season) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [c1, userId, p1, 420, (420 * 3.12 / 1000).toFixed(4), 'verified',
     'sha256:a3f2d1e89bc04c6a7e5f8d2b1c9e0a7f3d2b5c8e1f4a7b0c3d6e9f2a5b8c1d4',
     1.31, 26.2, 'wet_rice']);

  // MRV log
  db.run(`INSERT INTO mrv_logs (id,carbon_id,tier,action,operator,data_hash) VALUES (?,?,?,?,?,?)`,
    [uuidv4(), c1, 1, 'Field mass verified', 'HTX-CM-01',
     'sha256:b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6']);
  db.run(`INSERT INTO mrv_logs (id,carbon_id,tier,action,operator,data_hash) VALUES (?,?,?,?,?,?)`,
    [uuidv4(), c1, 2, 'EBC lab analysis complete', 'HUSK Vietnam',
     'sha256:c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7']);

  // Points
  db.run(`INSERT INTO points (id,user_id,amount,type,reason,ref_id) VALUES (?,?,?,?,?,?)`,
    [uuidv4(), userId, 1200, 'earned', '1 pt per kg delivered', p1]);

  // Salinity readings
  const stations = [
    { station: 'Trạm Cà Mau', province: 'ca-mau', river: 'Sông Gành Hào', value: 2.1 },
    { station: 'Trạm Sóc Trăng', province: 'soc-trang', river: 'Sông Hậu', value: 5.8 },
    { station: 'Trạm Bến Tre', province: 'ben-tre', river: 'Sông Tiền', value: 3.4 },
    { station: 'Trạm Kiên Giang', province: 'kien-giang', river: 'Sông Cái Lớn', value: 1.2 },
  ];
  for (const s of stations) {
    db.run(`INSERT INTO salinity_readings (id,station,province,river,value_gpl,recorded_at,alert) VALUES (?,?,?,?,?,?,?)`,
      [uuidv4(), s.station, s.province, s.river, s.value,
       new Date().toISOString(), s.value >= 5 ? 1 : 0]);
  }

  // Notifications
  db.run(`INSERT INTO notifications (id,user_id,title,body,type) VALUES (?,?,?,?,?)`,
    [uuidv4(), userId, '⚠️ Salinity Alert - Sóc Trăng', 'Station Sóc Trăng reads 5.8 g/L - above 5 g/L threshold. Switch to rice season.', 'alert']);
  db.run(`INSERT INTO notifications (id,user_id,title,body,type) VALUES (?,?,?,?,?)`,
    [uuidv4(), userId, '✅ Carbon Credit Verified', 'Your 1.31 SCU from May harvest has been verified under VM0044.', 'success']);

  saveDb();
}

module.exports = { getDb, saveDb };
