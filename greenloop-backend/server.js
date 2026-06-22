require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// Pre-load DB on startup
const { getDb } = require('./src/db');

const authRoutes     = require('./src/routes/auth');
const pickupRoutes   = require('./src/routes/pickups');
const salinityRoutes = require('./src/routes/salinity');
const carbonRoutes   = require('./src/routes/carbon');
const miscRoutes     = require('./src/routes/misc');
const adminRoutes    = require('./src/routes/admin');
const platformRoutes = require('./src/routes/platform');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000' }));
app.use(express.json({ limit: '1mb' }));

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth',        authRoutes);
app.use('/api/pickups',     pickupRoutes);
app.use('/api/salinity',    salinityRoutes);
app.use('/api/carbon',      carbonRoutes);
app.use('/api',             miscRoutes);      // notifications + points
app.use('/api/admin',       adminRoutes);
app.use('/api/platform',    platformRoutes);
app.use(express.static(path.join(__dirname, '..')));

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'GreenLoop API', version: '1.0.0', time: new Date().toISOString() });
});

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Error handler ───────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ───────────────────────────────────────────────────────────────────
getDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🌿 GreenLoop API running on http://localhost:${PORT}`);
    console.log(`   Health:   GET  /health`);
    console.log(`   Auth:     POST /api/auth/register | /api/auth/login`);
    console.log(`   Pickups:  GET/POST /api/pickups`);
    console.log(`   Salinity: GET /api/salinity`);
    console.log(`   Carbon:   GET /api/carbon`);
    console.log(`   Points:   GET /api/points`);
    console.log(`   Admin:    GET /api/admin/stats\n`);
    console.log(`   Demo login: phone=0901234567 / password=demo1234\n`);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
