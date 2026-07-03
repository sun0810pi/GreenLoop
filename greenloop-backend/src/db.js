const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

let db;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../greenloop.db.json');

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
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
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
      biomass_type  TEXT NOT NULL,   -- rice_straw | pond_sludge | tram | mixed
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
      source      TEXT DEFAULT 'seed_demo',
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

    CREATE TABLE IF NOT EXISTS partners (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      contact_email TEXT, province TEXT, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS biomass_batches (
      id TEXT PRIMARY KEY, batch_code TEXT UNIQUE NOT NULL, owner_id TEXT NOT NULL,
      pickup_id TEXT, biomass_type TEXT NOT NULL, input_kg REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'received', custody_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_tasks (
      id TEXT PRIMARY KEY, batch_id TEXT, title TEXT NOT NULL, assignee_role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', due_at TEXT, notes TEXT, created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, batch_id TEXT, name TEXT NOT NULL, category TEXT NOT NULL,
      quantity_kg REAL NOT NULL, unit_price_vnd REAL NOT NULL, status TEXT NOT NULL DEFAULT 'available',
      carbon_record_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS logistics_routes (
      id TEXT PRIMARY KEY, route_name TEXT NOT NULL, province TEXT NOT NULL,
      scheduled_at TEXT NOT NULL, capacity_kg REAL NOT NULL, assigned_kg REAL NOT NULL DEFAULT 0,
      cost_per_ton_vnd REAL NOT NULL, status TEXT NOT NULL DEFAULT 'planned', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS partner_requests (
      id TEXT PRIMARY KEY, partner_id TEXT NOT NULL, request_type TEXT NOT NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verification_cases (
      id TEXT PRIMARY KEY, carbon_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      validator TEXT, evidence_hash TEXT, notes TEXT, created_at TEXT NOT NULL, verified_at TEXT
    );
    CREATE TABLE IF NOT EXISTS carbon_offers (
      id TEXT PRIMARY KEY, carbon_id TEXT NOT NULL, seller_id TEXT NOT NULL,
      tonnes REAL NOT NULL, price_per_tonne_usd REAL NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS carbon_trade_requests (
      id TEXT PRIMARY KEY, offer_id TEXT NOT NULL, buyer_id TEXT NOT NULL,
      tonnes REAL NOT NULL, message TEXT, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, actor_id TEXT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      action TEXT NOT NULL, metadata TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS farm_ecosystem_profiles (
      id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL, zone_code TEXT NOT NULL,
      aquatic_system TEXT NOT NULL, melaleuca_ha REAL NOT NULL DEFAULT 0,
      practices TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS environmental_readings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, station TEXT NOT NULL, province TEXT NOT NULL,
      metric TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL, sampled_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual', alert INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS field_plots (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, province TEXT,
      area_ha REAL NOT NULL DEFAULT 0, crop_type TEXT NOT NULL DEFAULT 'rice',
      lat REAL, lng REAL, boundary TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS iot_install_requests (
      id TEXT PRIMARY KEY, plot_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_sensors TEXT NOT NULL DEFAULT '["salinity","ph","moisture"]',
      admin_id TEXT, admin_notes TEXT, requested_at TEXT NOT NULL,
      decided_at TEXT, installed_at TEXT,
      FOREIGN KEY (plot_id) REFERENCES field_plots(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS soil_samples (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ph REAL, organic_matter_pct REAL, moisture_pct REAL,
      soil_carbon_pct REAL, lab_name TEXT, evidence_hash TEXT NOT NULL, sampled_at TEXT NOT NULL,
      created_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS refinery_runs (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, process TEXT NOT NULL, input_kg REAL NOT NULL,
      output_kg REAL, output_type TEXT, quality_grade TEXT, status TEXT NOT NULL DEFAULT 'planned',
      notes TEXT, started_at TEXT NOT NULL, completed_at TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES biomass_batches(id)
    );
    CREATE TABLE IF NOT EXISTS finance_applications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, product_type TEXT NOT NULL, amount_vnd REAL NOT NULL,
      purpose TEXT NOT NULL, readiness_score INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'submitted',
      evidence_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS residues (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, pickup_id TEXT, name TEXT NOT NULL,
      residue_type TEXT NOT NULL, source_category TEXT NOT NULL, origin TEXT NOT NULL,
      quantity REAL NOT NULL, unit TEXT NOT NULL DEFAULT 'kg', status TEXT NOT NULL DEFAULT 'registered',
      collection_date TEXT, location TEXT NOT NULL, description TEXT, target_pathway_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (owner_id) REFERENCES users(id), FOREIGN KEY (pickup_id) REFERENCES pickups(id)
    );
    CREATE TABLE IF NOT EXISTS conversion_pathways (
      id TEXT PRIMARY KEY, input_type TEXT NOT NULL, output_name TEXT NOT NULL,
      output_category TEXT NOT NULL, processing_level TEXT NOT NULL,
      market_channel TEXT NOT NULL, can_return_to_field INTEGER NOT NULL DEFAULT 0,
      process_name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS logistics_assignments (
      id TEXT PRIMARY KEY, route_id TEXT NOT NULL, pickup_id TEXT, batch_id TEXT, residue_id TEXT,
      collector_id TEXT, processor_id TEXT, pickup_location TEXT NOT NULL, delivery_location TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting_collection', handoff_at TEXT, received_at TEXT,
      evidence_hash TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (route_id) REFERENCES logistics_routes(id)
    );
    CREATE TABLE IF NOT EXISTS field_applications (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, user_id TEXT NOT NULL, field_location TEXT NOT NULL,
      quantity REAL NOT NULL, unit TEXT NOT NULL DEFAULT 'kg', application_type TEXT NOT NULL,
      expected_benefit TEXT, applied_at TEXT NOT NULL, evidence_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id), FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS certificates (
      id TEXT PRIMARY KEY, certificate_no TEXT UNIQUE NOT NULL, entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL, certificate_type TEXT NOT NULL, standard TEXT NOT NULL,
      issuer TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', scope TEXT,
      issued_at TEXT, valid_until TEXT, evidence_hash TEXT NOT NULL,
      blockchain_tx TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);

  migrateSchema();

  saveDb();
}

function tableColumns(table) {
  return (db.exec(`PRAGMA table_info(${table})`)[0]?.values || []).map(row => row[1]);
}

function addColumnIfMissing(table, column, definition) {
  if (!tableColumns(table).includes(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateSchema() {
  addColumnIfMissing('pickups', 'sale_price_vnd', 'REAL DEFAULT 0');
  addColumnIfMissing('pickups', 'buyer_name', 'TEXT');
  addColumnIfMissing('pickups', 'payment_status', "TEXT DEFAULT 'pending'");
  addColumnIfMissing('pickups', 'farmer_share_vnd', 'REAL DEFAULT 0');
  addColumnIfMissing('pickups', 'htx_share_vnd', 'REAL DEFAULT 0');
  addColumnIfMissing('pickups', 'platform_share_vnd', 'REAL DEFAULT 0');
  addColumnIfMissing('pickups', 'advance_vnd', 'REAL DEFAULT 0');
  addColumnIfMissing('pickups', 'payment_evidence_hash', 'TEXT');
  addColumnIfMissing('pickups', 'buyer_paid_at', 'TEXT');
  addColumnIfMissing('pickups', 'farmer_paid_at', 'TEXT');
  try {
    db.run(
      `UPDATE pickups
       SET sale_price_vnd=1800000, buyer_name='Mekong Biochar Buyer', payment_status='buyer_paid',
           farmer_share_vnd=1260000, htx_share_vnd=360000, platform_share_vnd=180000,
           advance_vnd=500000, payment_evidence_hash='sha256:demo-biomass-sale-ledger',
           buyer_paid_at=COALESCE(buyer_paid_at, datetime('now'))
       WHERE id IN ('pickup-demo-ready-001') AND COALESCE(sale_price_vnd,0)=0`
    );
    db.run(
      `UPDATE pickups
       SET sale_price_vnd=1850000, buyer_name='HUSK Vietnam', payment_status='buyer_paid',
           farmer_share_vnd=1295000, htx_share_vnd=370000, platform_share_vnd=185000,
           payment_evidence_hash='sha256:demo-pickup-sale-ledger',
           buyer_paid_at=COALESCE(buyer_paid_at, datetime('now'))
       WHERE biomass_type='rice_straw' AND status='processed' AND COALESCE(sale_price_vnd,0)=0`
    );
  } catch {}
  try {
    db.run(`UPDATE salinity_readings SET source='seed_demo' WHERE source IS NULL OR source='mrc_api'`);
  } catch {}
  addColumnIfMissing('products', 'source_residue_id', 'TEXT');
  addColumnIfMissing('products', 'conversion_pathway_id', 'TEXT');
  addColumnIfMissing('products', 'description', 'TEXT');
  addColumnIfMissing('products', 'unit', "TEXT DEFAULT 'kg'");
  addColumnIfMissing('products', 'channel', "TEXT DEFAULT 'market'");
  addColumnIfMissing('products', 'return_to_field', 'INTEGER DEFAULT 0');
}

function runUpdate(sql, params = []) {
  try { db.run(sql, params); } catch {}
}

function hasRow(table, id) {
  return Boolean(db.exec(`SELECT id FROM ${table} WHERE id='${id}'`)[0]?.values.length);
}

function ensureForestProductDemo() {
  const now = new Date().toISOString();
  const pathways = [
    ['path-coffee-tea', 'coffee_leaves', 'Trà lá cà phê', 'coffee_leaf_tea', 'market', 'market', 0, 'Sấy và phối trộn trà thảo mộc', 'Lá cà phê được chuyển thành sản phẩm đồ uống có thể truy xuất.'],
    ['path-coffee-stem-biochar', 'coffee_stems', 'Biochar từ thân cà phê', 'biochar', 'bio_refinery', 'farm_return', 1, 'Nhiệt phân yếm khí', 'Thân cà phê được chuyển thành biochar có truy xuất nguồn gốc.'],
    ['path-coffee-bark-biochar', 'coffee_bark', 'Biochar từ vỏ cà phê', 'biochar', 'bio_refinery', 'farm_return', 1, 'Nhiệt phân yếm khí', 'Vỏ cà phê được chuyển thành biochar có truy xuất nguồn gốc.']
  ];
  pathways.forEach(p => {
    if (!hasRow('conversion_pathways', p[0])) db.run('INSERT INTO conversion_pathways VALUES (?,?,?,?,?,?,?,?,?,?)', [...p, now]);
  });
  runUpdate("UPDATE conversion_pathways SET input_type='coffee_leaves', description='Lá cà phê được chuyển thành sản phẩm đồ uống có thể truy xuất.' WHERE id='path-coffee-tea'");

  const residues = [
    ['res-coffee-leaf-001', 'user-demo-001', null, 'Lá cà phê sau tỉa cành', 'coffee_leaves', 'forestry', 'Vườn cà phê liên kết HTX', 180, 'kg', 'classified', '2026-06-01T07:00:00Z', 'Lam Dong partner hub', 'Lá phù hợp cho dòng trà lá cà phê.', 'path-coffee-tea'],
    ['res-coffee-stem-001', 'user-demo-001', null, 'Thân cà phê sau tái canh', 'coffee_stems', 'forestry', 'Vườn cà phê tái canh', 420, 'kg', 'classified', '2026-06-02T07:00:00Z', 'Lam Dong partner hub', 'Thân khô phù hợp cho nhiệt phân biochar.', 'path-coffee-stem-biochar'],
    ['res-coffee-bark-001', 'user-demo-001', null, 'Vỏ cà phê từ cơ sở sơ chế', 'coffee_bark', 'forestry', 'HTX sơ chế cà phê', 300, 'kg', 'classified', '2026-06-03T07:00:00Z', 'Lam Dong partner hub', 'Vỏ phù hợp cho nhiệt phân biochar.', 'path-coffee-bark-biochar'],
    ['res-coconut-water-001', 'user-demo-001', null, 'Bã dừa nước sau sơ chế', 'coconut_water_residue', 'forestry', 'Cơ sở sơ chế dừa nước', 260, 'kg', 'classified', '2026-06-06T07:00:00Z', 'Ben Tre partner hub', 'Bã dừa nước được tách riêng khỏi dòng tràm.', 'path-coconut-packaging']
  ];
  residues.forEach(r => {
    if (!hasRow('residues', r[0])) db.run('INSERT INTO residues VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [...r, now, now]);
  });
  runUpdate("UPDATE residues SET source_category='forestry' WHERE residue_type IN ('coffee_leaves','coffee_stems','coffee_bark','coffee_husk','coconut_husk','coconut_water_residue')");

  const { v4: uuidv4 } = require('uuid');
  const productExists = db.exec("SELECT id FROM products WHERE source_residue_id='res-coffee-leaf-001'")[0]?.values.length;
  if (!productExists) {
    db.run('INSERT INTO products (id,batch_id,name,category,quantity_kg,unit_price_vnd,status,carbon_record_id,created_at,source_residue_id,conversion_pathway_id,description,channel,return_to_field) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [uuidv4(), null, 'Lô thử nghiệm trà lá cà phê', 'coffee_leaf_tea', 80, 95000, 'ready_for_sale', null, now, 'res-coffee-leaf-001', 'path-coffee-tea', 'Sản phẩm trà thảo mộc từ dòng lá cà phê.', 'market', 0]);
  }
}

function normalizeDemoDates() {
  const demoDates = {
    ricePickup: '2026-05-10T07:00:00Z',
    sludgePickup: '2026-05-20T07:00:00Z',
    riceResidue: '2026-05-10T07:00:00Z',
    coffeeResidue: '2026-06-01T07:00:00Z',
    coconutResidue: '2026-06-05T07:00:00Z',
    aquaResidue: '2026-06-08T07:00:00Z'
  };
  runUpdate("UPDATE pickups SET scheduled_at=? WHERE biomass_type='rice_straw' AND scheduled_at LIKE '2025-05-10%'", [demoDates.ricePickup]);
  runUpdate("UPDATE pickups SET scheduled_at=? WHERE biomass_type='pond_sludge' AND scheduled_at LIKE '2025-05-20%'", [demoDates.sludgePickup]);
  runUpdate("UPDATE residues SET collection_date=? WHERE id='res-rice-001'", [demoDates.riceResidue]);
  runUpdate("UPDATE residues SET collection_date=? WHERE id IN ('res-coffee-leaf-001','res-coffee-stem-001','res-coffee-bark-001')", [demoDates.coffeeResidue]);
  runUpdate("UPDATE residues SET collection_date=? WHERE id='res-coconut-001'", [demoDates.coconutResidue]);
  runUpdate("UPDATE residues SET collection_date=? WHERE id='res-aqua-001'", [demoDates.aquaResidue]);
  runUpdate("UPDATE notifications SET body=? WHERE body='Your 1.31 SCU from May harvest has been verified under VM0044.'", ['Your 1.31 SCU from the 05/2026 harvest has been verified under VM0044.']);
}

function seedPlatformData() {
  const { v4: uuidv4 } = require('uuid');
  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');
  const now = new Date().toISOString();
  const partnerCount = db.exec("SELECT COUNT(*) AS c FROM partners")[0]?.values[0][0] || 0;
  if (!partnerCount) {
    const partners = [
      ['partner-husk', 'HUSK Vietnam', 'biochar_processor', 'ops@husk.example', 'can-tho', 'active'],
      ['partner-tomtex', 'TomTex', 'material_buyer', 'sourcing@tomtex.example', 'ho-chi-minh', 'active'],
      ['partner-biorefinery', 'Mekong Bio-refinery', 'bio_refinery', 'intake@mekongbio.example', 'ca-mau', 'active']
    ];
    partners.forEach(p => db.run('INSERT INTO partners VALUES (?,?,?,?,?,?,?)', [...p, now]));
    const batchId = 'batch-demo-001';
    db.run('INSERT INTO biomass_batches VALUES (?,?,?,?,?,?,?,?,?,?)', [batchId, 'GL-CM-2026-0001', 'user-demo-001', null, 'rice_straw', 1200, 'processing', 'sha256:demo-custody-chain-2026-0001', now, now]);
    db.run('INSERT INTO workflow_tasks VALUES (?,?,?,?,?,?,?,?,?)', [uuidv4(), batchId, 'Upload EBC laboratory analysis', 'partner', 'open', new Date(Date.now()+86400000*3).toISOString(), 'Required before verification', now, null]);
    db.run('INSERT INTO workflow_tasks VALUES (?,?,?,?,?,?,?,?,?)', [uuidv4(), batchId, 'Confirm route weighbridge record', 'htx', 'in_progress', new Date(Date.now()+86400000).toISOString(), 'Route CM-01', now, null]);
    db.run('INSERT INTO products (id,batch_id,name,category,quantity_kg,unit_price_vnd,status,carbon_record_id,created_at,description,channel,return_to_field) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [uuidv4(), batchId, 'EBC Biochar - rice straw', 'biochar', 420, 6800, 'available', null, now, 'Soil amendment and carbon storage product from rice straw.', 'farm_return', 1]);
    db.run('INSERT INTO logistics_routes VALUES (?,?,?,?,?,?,?,?,?)', [uuidv4(), 'CM-01: Tran Van Thoi hub', 'ca-mau', new Date(Date.now()+86400000*2).toISOString(), 5000, 3200, 280000, 'dispatching', now]);
    db.run('INSERT INTO partner_requests VALUES (?,?,?,?,?,?,?)', [uuidv4(), 'partner-husk', 'batch_processing', JSON.stringify({ batch_code: 'GL-CM-2026-0001', requested_output: 'biochar' }), 'accepted', now, now]);
    db.run('INSERT INTO farm_ecosystem_profiles VALUES (?,?,?,?,?,?,?)', [uuidv4(), 'user-demo-001', 'brackish_transition', 'shrimp_crab_tilapia', 1.2, JSON.stringify(['low_chemical', 'water_monitoring', 'biomass_custody']), now]);
  }
  const password = bcrypt.hashSync('demo1234', 10);
  const demoUsers = [
    ['user-buyer-001', 'Green Capital Buyer', '0923456789', 'buyer@greenloop.vn', 'buyer'],
    ['user-partner-001', 'Mekong Bio-refinery', '0934567890', 'partner@greenloop.vn', 'partner'],
    ['user-admin-001', 'GreenLoop Administrator', '0945678901', 'admin@greenloop.vn', 'admin']
  ];
  demoUsers.forEach(([id, name, phone, email, role]) => {
    const exists = db.exec(`SELECT id FROM users WHERE id='${id}'`)[0]?.values.length;
    if (!exists) db.run('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?,?)', [id, name, phone, email, password, role, 'ca-mau', 0, null, now, null]);
  });
  const soilCount = db.exec("SELECT COUNT(*) AS c FROM soil_samples WHERE user_id='user-demo-001'")[0]?.values[0][0] || 0;
  if (!soilCount) {
    const evidence = 'sha256:' + require('crypto').createHash('sha256').update(`soil|user-demo-001|${now}`).digest('hex');
    const soilCols = (db.exec("PRAGMA table_info(soil_samples)")[0]?.values || []).map(row => row[1]);
    if (soilCols.includes('created_at')) {
      db.run('INSERT INTO soil_samples (id,user_id,ph,organic_matter_pct,moisture_pct,soil_carbon_pct,lab_name,evidence_hash,sampled_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [uuidv4(), 'user-demo-001', 6.4, 2.8, 72, 1.7, 'HTX-CM-01 field kit', evidence, now, now]);
    } else {
      db.run('INSERT INTO soil_samples (id,user_id,ph,organic_matter_pct,moisture_pct,soil_carbon_pct,lab_name,evidence_hash,sampled_at) VALUES (?,?,?,?,?,?,?,?,?)', [uuidv4(), 'user-demo-001', 6.4, 2.8, 72, 1.7, 'HTX-CM-01 field kit', evidence, now]);
    }
  }
  const envCount = db.exec("SELECT COUNT(*) AS c FROM environmental_readings WHERE user_id='user-demo-001'")[0]?.values[0][0] || 0;
  if (!envCount) {
    const envCols = (db.exec("PRAGMA table_info(environmental_readings)")[0]?.values || []).map(row => row[1]);
    const envSql = envCols.includes('created_at')
      ? 'INSERT INTO environmental_readings (id,user_id,station,province,metric,value,unit,sampled_at,source,alert,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      : 'INSERT INTO environmental_readings (id,user_id,station,province,metric,value,unit,sampled_at,source,alert) VALUES (?,?,?,?,?,?,?,?,?,?)';
    const addEnv = (metric, station, value, unit, alert = 0) => {
      const base = [uuidv4(), 'user-demo-001', station, 'ca-mau', metric, value, unit, now, 'iot_sensor', alert];
      db.run(envSql, envCols.includes('created_at') ? [...base, now] : base);
    };
    addEnv('dissolved_oxygen', 'Pond W-01', 5.8, 'mg/L');
    addEnv('moisture', 'Field A', 72, '%');
  }
  const offerCount = db.exec("SELECT COUNT(*) AS c FROM carbon_offers")[0]?.values[0][0] || 0;
  if (!offerCount) {
    const carbon = db.exec("SELECT id, user_id, co2e_tonnes FROM carbon_records WHERE status IN ('verified','issued') ORDER BY created_at DESC LIMIT 1")[0]?.values[0];
    if (carbon) db.run('INSERT INTO carbon_offers VALUES (?,?,?,?,?,?,?)', [uuidv4(), carbon[0], carbon[1], Number(carbon[2]), 20, 'open', now]);
  }
  seedCircularDomain(now, crypto);
  saveDb();
}

function seedCircularDomain(now, crypto) {
  const { v4: uuidv4 } = require('uuid');
  const pathwayCount = db.exec("SELECT COUNT(*) AS c FROM conversion_pathways")[0]?.values[0][0] || 0;
  if (!pathwayCount) {
    const pathways = [
      ['path-coffee-tea', 'coffee_leaves', 'Trà lá cà phê', 'coffee_leaf_tea', 'market', 'market', 0, 'Sấy và phối trộn trà thảo mộc', 'Lá cà phê được chuyển thành sản phẩm đồ uống có thể truy xuất.'],
      ['path-coffee-stem-biochar', 'coffee_stems', 'Biochar từ thân cà phê', 'biochar', 'bio_refinery', 'farm_return', 1, 'Nhiệt phân yếm khí', 'Thân cà phê được chuyển thành biochar có truy xuất nguồn gốc.'],
      ['path-coffee-bark-biochar', 'coffee_bark', 'Biochar từ vỏ cà phê', 'biochar', 'bio_refinery', 'farm_return', 1, 'Nhiệt phân yếm khí', 'Vỏ cà phê được chuyển thành biochar có truy xuất nguồn gốc.'],
      ['path-rice-mushroom', 'rice_straw', 'Nấm rơm', 'mushroom', 'market', 'market', 0, 'Ủ giá thể nấm', 'Rơm rạ được dùng làm giá thể sản xuất nấm rơm.'],
      ['path-rice-mulch', 'rice_straw', 'Màng phủ sinh học', 'mulch', 'bio_refinery', 'bio_refinery', 1, 'Nghiền xơ và đúc màng phủ', 'Xơ rơm rạ được chuyển thành màng phủ có thể quay lại đồng ruộng.'],
      ['path-rice-biochar', 'rice_straw', 'Biochar từ rơm rạ', 'biochar', 'bio_refinery', 'farm_return', 1, 'Nhiệt phân yếm khí', 'Biochar lưu trữ carbon và cải thiện khả năng giữ nước của đất.'],
      ['path-coconut-packaging', 'coconut_husk', 'Bao bì thực phẩm sinh học', 'food_packaging', 'bio_refinery', 'market', 0, 'Tách xơ và ép khuôn', 'Xơ vỏ dừa được ép khuôn thành bao bì thực phẩm.'],
      ['path-coconut-leather', 'coconut_husk', 'Tấm da sinh học', 'bio_leather', 'bio_refinery', 'market', 0, 'Gia cường xơ và hoàn thiện composite sinh học', 'Xơ dừa được xử lý thành vật liệu giống da.'],
      ['path-aquatic-bioproduct', 'shrimp_shells', 'Đầu vào bảo vệ cây trồng sinh học', 'bio_pesticide', 'bio_refinery', 'farm_return', 1, 'Tách chitin và phối chế vi sinh', 'Phụ phẩm thủy sản trở thành đầu vào nông nghiệp giúp giảm hóa chất.'],
      ['path-eco-tourism', 'melaleuca_residue', 'Trải nghiệm du lịch sinh thái tuần hoàn', 'eco_tourism', 'market', 'market', 0, 'Đóng gói câu chuyện nông trại và vận hành trải nghiệm', 'Thực hành tuần hoàn đã xác minh trở thành sản phẩm du lịch sinh thái.']
    ];
    pathways.forEach(p => db.run('INSERT INTO conversion_pathways VALUES (?,?,?,?,?,?,?,?,?,?)', [...p, now]));
  }

  const residueCount = db.exec("SELECT COUNT(*) AS c FROM residues")[0]?.values[0][0] || 0;
  if (!residueCount) {
    const residues = [
      ['res-rice-001', 'user-demo-001', null, 'Rơm rạ sau vụ lúa', 'rice_straw', 'agriculture', 'Ruộng lúa mùa mưa', 1200, 'kg', 'processing', '2026-05-10T07:00:00Z', 'Khanh Binh Tay, Tran Van Thoi, Ca Mau', 'Rơm sạch được bó tại bờ ruộng.', 'path-rice-biochar'],
      ['res-coffee-leaf-001', 'user-demo-001', null, 'Lá cà phê sau tỉa cành', 'coffee_leaves', 'forestry', 'Vườn cà phê liên kết HTX', 180, 'kg', 'classified', '2026-06-01T07:00:00Z', 'Lam Dong partner hub', 'Lá phù hợp cho dòng trà lá cà phê.', 'path-coffee-tea'],
      ['res-coffee-stem-001', 'user-demo-001', null, 'Thân cà phê sau tái canh', 'coffee_stems', 'forestry', 'Vườn cà phê tái canh', 420, 'kg', 'classified', '2026-06-02T07:00:00Z', 'Lam Dong partner hub', 'Thân khô phù hợp cho nhiệt phân biochar.', 'path-coffee-stem-biochar'],
      ['res-coffee-bark-001', 'user-demo-001', null, 'Vỏ cà phê từ cơ sở sơ chế', 'coffee_bark', 'forestry', 'HTX sơ chế cà phê', 300, 'kg', 'classified', '2026-06-03T07:00:00Z', 'Lam Dong partner hub', 'Vỏ phù hợp cho nhiệt phân biochar.', 'path-coffee-bark-biochar'],
      ['res-coconut-001', 'user-demo-001', null, 'Lô xơ vỏ dừa', 'coconut_husk', 'forestry', 'Nông trại và cơ sở sơ chế dừa', 650, 'kg', 'classified', '2026-06-05T07:00:00Z', 'Ben Tre partner hub', 'Xơ dài phù hợp cho bao bì và da sinh học.', 'path-coconut-packaging'],
      ['res-coconut-water-001', 'user-demo-001', null, 'Bã dừa nước sau sơ chế', 'coconut_water_residue', 'forestry', 'Cơ sở sơ chế dừa nước', 260, 'kg', 'classified', '2026-06-06T07:00:00Z', 'Ben Tre partner hub', 'Bã dừa nước được tách riêng khỏi dòng tràm.', 'path-coconut-packaging'],
      ['res-aqua-001', 'user-demo-001', null, 'Phụ phẩm vỏ tôm', 'shrimp_shells', 'aquaculture', 'Dây chuyền sơ chế tôm', 240, 'kg', 'received', '2026-06-08T07:00:00Z', 'Ca Mau seafood processor', 'Vỏ tôm được giữ lại cho dòng chitin.', 'path-aquatic-bioproduct']
    ];
    residues.forEach(r => db.run('INSERT INTO residues VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [...r, now, now]));
  }

  const productCount = db.exec("SELECT COUNT(*) AS c FROM products WHERE source_residue_id IN ('res-coffee-leaf-001','res-rice-001','res-coconut-001','res-aqua-001')")[0]?.values[0][0] || 0;
  if (!productCount) {
    const products = [
      ['Lô thử nghiệm trà lá cà phê', 'coffee_leaf_tea', 80, 95000, 'ready_for_sale', 'res-coffee-leaf-001', 'path-coffee-tea', 'Sản phẩm trà thảo mộc từ dòng lá cà phê.', 'market', 0],
      ['Gói giá thể nấm rơm', 'mushroom', 220, 18000, 'producing', 'res-rice-001', 'path-rice-mushroom', 'Sản phẩm nấm thương mại từ rơm rạ.', 'market', 0],
      ['Tấm bao bì thực phẩm sinh học', 'food_packaging', 160, 42000, 'ready_for_sale', 'res-coconut-001', 'path-coconut-packaging', 'Vật liệu bao bì thực phẩm chế biến sâu.', 'bio_refinery', 0],
      ['Tấm mẫu da sinh học', 'bio_leather', 45, 180000, 'ready_for_sale', 'res-coconut-001', 'path-coconut-leather', 'Vật liệu composite sinh học giống da.', 'bio_refinery', 0],
      ['Đầu vào bảo vệ cây trồng sinh học', 'bio_pesticide', 120, 52000, 'distributed', 'res-aqua-001', 'path-aquatic-bioproduct', 'Đầu vào sinh học từ chitin có thể quay lại đồng ruộng.', 'farm_return', 1]
    ];
    products.forEach(p => db.run('INSERT INTO products (id,batch_id,name,category,quantity_kg,unit_price_vnd,status,carbon_record_id,created_at,source_residue_id,conversion_pathway_id,description,channel,return_to_field) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [uuidv4(), null, p[0], p[1], p[2], p[3], p[4], null, now, p[5], p[6], p[7], p[8], p[9]]));
  }

  const route = db.exec("SELECT id FROM logistics_routes ORDER BY created_at DESC LIMIT 1")[0]?.values[0]?.[0];
  const assignmentCount = db.exec("SELECT COUNT(*) AS c FROM logistics_assignments")[0]?.values[0][0] || 0;
  if (route && !assignmentCount) {
    const evidence = 'sha256:' + crypto.createHash('sha256').update(`route|${route}|res-rice-001|${now}`).digest('hex');
    db.run('INSERT INTO logistics_assignments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [uuidv4(), route, null, 'batch-demo-001', 'res-rice-001', 'user-htx-001', 'partner-husk', 'Khanh Binh Tay collection point', 'Mekong Bio-refinery intake bay', 'delivered', now, now, evidence, 'Demo custody handoff for rice straw biochar.', now, now]);
  }

  const farmReturnCount = db.exec("SELECT COUNT(*) AS c FROM field_applications")[0]?.values[0][0] || 0;
  if (!farmReturnCount) {
    const product = db.exec("SELECT id FROM products WHERE return_to_field=1 ORDER BY created_at LIMIT 1")[0]?.values[0]?.[0];
    if (product) {
      const evidence = 'sha256:' + crypto.createHash('sha256').update(`field|${product}|user-demo-001|${now}`).digest('hex');
      db.run('INSERT INTO field_applications VALUES (?,?,?,?,?,?,?,?,?,?,?)', [uuidv4(), product, 'user-demo-001', 'Field A - Khanh Binh Tay', 95, 'kg', 'soil_improvement', 'Improve water retention, soil carbon and reduce synthetic inputs.', now, evidence, now]);
    }
  }

  const certCount = db.exec("SELECT COUNT(*) AS c FROM certificates")[0]?.values[0][0] || 0;
  if (!certCount) {
    const carbon = db.exec("SELECT id FROM carbon_records ORDER BY created_at DESC LIMIT 1")[0]?.values[0]?.[0] || 'demo-carbon';
    const evidence = 'sha256:' + crypto.createHash('sha256').update(`certificate|${carbon}|${now}`).digest('hex');
    db.run('INSERT INTO certificates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [uuidv4(), 'GL-ESG-2026-0001', 'carbon_record', carbon, 'carbon_certificate', 'Verra VM0044 / EBC C-sink ready', 'GreenLoop MRV Desk', 'issued', 'Rice straw biochar carbon removal evidence package', now, new Date(Date.now()+86400000*365).toISOString(), evidence, 'tx-demo-greenloop-0001', now, now]);
  }
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
     '2026-05-10T07:00:00Z', 'processed', 420]);

  const p2 = uuidv4();
  db.run(`INSERT INTO pickups (id,user_id,biomass_type,quantity_kg,location,province,scheduled_at,status) VALUES (?,?,?,?,?,?,?,?)`,
    [p2, userId, 'pond_sludge', 800, 'Xã Khánh Bình Tây, huyện Trần Văn Thời', 'ca-mau',
     '2026-05-20T07:00:00Z', 'confirmed']);

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
    db.run(`INSERT INTO salinity_readings (id,station,province,river,value_gpl,recorded_at,source,alert) VALUES (?,?,?,?,?,?,?,?)`,
      [uuidv4(), s.station, s.province, s.river, s.value,
       new Date().toISOString(), 'seed_demo', s.value >= 5 ? 1 : 0]);
  }

  // Notifications
  db.run(`INSERT INTO notifications (id,user_id,title,body,type) VALUES (?,?,?,?,?)`,
    [uuidv4(), userId, '⚠️ Salinity Alert - Sóc Trăng', 'Station Sóc Trăng reads 5.8 g/L - above 5 g/L threshold. Switch to rice season.', 'alert']);
  db.run(`INSERT INTO notifications (id,user_id,title,body,type) VALUES (?,?,?,?,?)`,
    [uuidv4(), userId, '✅ Carbon Credit Verified', 'Your 1.31 SCU from the 05/2026 harvest has been verified under VM0044.', 'success']);

  saveDb();
}

module.exports = { getDb, saveDb };
