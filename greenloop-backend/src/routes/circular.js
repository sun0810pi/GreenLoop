const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb, saveDb } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { isBiomassType, normalizeBiomassType } = require('../biomass');

const router = express.Router();
const MANAGERS = ['htx', 'admin', 'partner'];
const RESIDUE_STATUSES = ['registered', 'classified', 'scheduled', 'collected', 'processing', 'converted', 'cancelled'];
const LOGISTICS_STATUSES = ['waiting_collection', 'in_transit', 'delivered', 'processed', 'cancelled'];
const PRODUCT_STATUSES = ['producing', 'ready_for_sale', 'distributed', 'returned_to_field', 'archived'];
const CERTIFICATE_STATUSES = ['draft', 'pending', 'verified', 'issued', 'revoked', 'expired'];

function rows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const output = [];
  while (stmt.step()) output.push(stmt.getAsObject());
  stmt.free();
  return output;
}
function one(db, sql, params = []) { return rows(db, sql, params)[0] || null; }
function clean(value, max = 200) { return String(value || '').trim().slice(0, max); }
function hashPayload(prefix, payload) {
  return 'sha256:' + crypto.createHash('sha256').update(`${prefix}|${JSON.stringify(payload)}`).digest('hex');
}
function audit(db, actorId, entityType, entityId, action, metadata) {
  db.run('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)', [uuidv4(), actorId || null, entityType, entityId, action, JSON.stringify(metadata || {}), new Date().toISOString()]);
}

router.get('/residues', auth, async (req, res, next) => {
  try {
    const db = await getDb();
    const mine = req.user.role === 'farmer';
    const status = clean(req.query.status, 30);
    const type = req.query.residue_type ? normalizeBiomassType(clean(req.query.residue_type, 50)) : null;
    const filters = mine ? ['r.owner_id = ?'] : ['1=1'];
    const params = mine ? [req.user.id] : [];
    if (status) { filters.push('r.status = ?'); params.push(status); }
    if (type) { filters.push('r.residue_type = ?'); params.push(type); }
    const data = rows(db, `
      SELECT r.*, u.name AS owner_name, cp.output_name AS target_output, cp.market_channel
      FROM residues r
      JOIN users u ON u.id = r.owner_id
      LEFT JOIN conversion_pathways cp ON cp.id = r.target_pathway_id
      WHERE ${filters.join(' AND ')}
      ORDER BY r.updated_at DESC
    `, params);
    res.json({ data });
  } catch (err) { next(err); }
});

router.post('/residues', auth, async (req, res, next) => {
  try {
    const residueType = normalizeBiomassType(clean(req.body.residue_type, 50));
    const quantity = Number(req.body.quantity);
    if (!clean(req.body.name) || !isBiomassType(residueType) || !Number.isFinite(quantity) || quantity <= 0 || !clean(req.body.location)) {
      return res.status(400).json({ error: 'name, valid residue_type, positive quantity and location are required' });
    }
    const db = await getDb();
    const now = new Date().toISOString();
    const id = uuidv4();
    db.run(`
      INSERT INTO residues
      (id,owner_id,pickup_id,name,residue_type,source_category,origin,quantity,unit,status,collection_date,location,description,target_pathway_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      id, req.user.id, clean(req.body.pickup_id, 80) || null, clean(req.body.name),
      residueType, clean(req.body.source_category, 50) || 'agriculture', clean(req.body.origin) || 'farm',
      quantity, clean(req.body.unit, 20) || 'kg', 'registered', clean(req.body.collection_date, 40) || null,
      clean(req.body.location), clean(req.body.description, 800) || null, clean(req.body.target_pathway_id, 80) || null,
      now, now
    ]);
    audit(db, req.user.id, 'residue', id, 'created', { residueType, quantity });
    saveDb();
    res.status(201).json({ id, status: 'registered' });
  } catch (err) { next(err); }
});

router.patch('/residues/:id/status', requireRole('farmer', ...MANAGERS), async (req, res, next) => {
  try {
    const status = clean(req.body.status, 30);
    if (!RESIDUE_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid residue status' });
    const db = await getDb();
    const residue = one(db, 'SELECT owner_id FROM residues WHERE id=?', [req.params.id]);
    if (!residue) return res.status(404).json({ error: 'Residue not found' });
    if (req.user.role === 'farmer' && residue.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    db.run('UPDATE residues SET status=?, updated_at=? WHERE id=?', [status, new Date().toISOString(), req.params.id]);
    audit(db, req.user.id, 'residue', req.params.id, 'status_changed', { status });
    saveDb();
    res.json({ status });
  } catch (err) { next(err); }
});

router.delete('/residues/:id', auth, async (req, res, next) => {
  try {
    const db = await getDb();
    const residue = one(db, 'SELECT owner_id,status FROM residues WHERE id=?', [req.params.id]);
    if (!residue) return res.status(404).json({ error: 'Residue not found' });
    if (req.user.role !== 'admin' && residue.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (!['registered', 'classified', 'cancelled'].includes(residue.status)) return res.status(400).json({ error: 'Only early-stage residues can be deleted' });
    db.run('DELETE FROM residues WHERE id=?', [req.params.id]);
    audit(db, req.user.id, 'residue', req.params.id, 'deleted', {});
    saveDb();
    res.json({ message: 'Residue deleted' });
  } catch (err) { next(err); }
});

router.get('/conversion-pathways', auth, async (req, res, next) => {
  try {
    const db = await getDb();
    const inputType = req.query.input_type ? normalizeBiomassType(clean(req.query.input_type, 50)) : null;
    const channel = clean(req.query.channel, 40);
    const filters = ['1=1'];
    const params = [];
    if (inputType) { filters.push('input_type = ?'); params.push(inputType); }
    if (channel) { filters.push('market_channel = ?'); params.push(channel); }
    res.json({ data: rows(db, `SELECT * FROM conversion_pathways WHERE ${filters.join(' AND ')} ORDER BY input_type, output_name`, params) });
  } catch (err) { next(err); }
});

router.post('/conversion-pathways', requireRole(...MANAGERS), async (req, res, next) => {
  try {
    const inputType = normalizeBiomassType(clean(req.body.input_type, 50));
    if (!isBiomassType(inputType) || !clean(req.body.output_name) || !clean(req.body.process_name)) return res.status(400).json({ error: 'Valid input_type, output_name and process_name are required' });
    const db = await getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    db.run('INSERT INTO conversion_pathways VALUES (?,?,?,?,?,?,?,?,?,?)', [
      id, inputType, clean(req.body.output_name), clean(req.body.output_category, 60) || 'bio_product',
      clean(req.body.processing_level, 40) || 'market', clean(req.body.market_channel, 40) || 'market',
      req.body.can_return_to_field ? 1 : 0, clean(req.body.process_name), clean(req.body.description, 800) || null, now
    ]);
    audit(db, req.user.id, 'conversion_pathway', id, 'created', { inputType });
    saveDb();
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

router.get('/logistics/assignments', auth, async (req, res, next) => {
  try {
    const db = await getDb();
    const data = rows(db, `
      SELECT la.*, lr.route_name, lr.province, b.batch_code, r.name AS residue_name
      FROM logistics_assignments la
      JOIN logistics_routes lr ON lr.id = la.route_id
      LEFT JOIN biomass_batches b ON b.id = la.batch_id
      LEFT JOIN residues r ON r.id = la.residue_id
      ORDER BY la.updated_at DESC
    `);
    res.json({ data });
  } catch (err) { next(err); }
});

router.post('/logistics/assignments', requireRole('htx', 'admin', 'partner'), async (req, res, next) => {
  try {
    const routeId = clean(req.body.route_id, 80);
    const pickupLocation = clean(req.body.pickup_location);
    const deliveryLocation = clean(req.body.delivery_location);
    if (!routeId || !pickupLocation || !deliveryLocation) return res.status(400).json({ error: 'route_id, pickup_location and delivery_location are required' });
    const db = await getDb();
    if (!one(db, 'SELECT id FROM logistics_routes WHERE id=?', [routeId])) return res.status(404).json({ error: 'Route not found' });
    const now = new Date().toISOString();
    const id = uuidv4();
    const evidence = hashPayload('logistics', { routeId, pickupLocation, deliveryLocation, now });
    db.run('INSERT INTO logistics_assignments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      id, routeId, clean(req.body.pickup_id, 80) || null, clean(req.body.batch_id, 80) || null,
      clean(req.body.residue_id, 80) || null, clean(req.body.collector_id, 80) || req.user.id,
      clean(req.body.processor_id, 80) || null, pickupLocation, deliveryLocation,
      clean(req.body.status, 40) || 'waiting_collection', null, null, evidence, clean(req.body.notes, 600) || null, now, now
    ]);
    audit(db, req.user.id, 'logistics_assignment', id, 'created', { routeId });
    saveDb();
    res.status(201).json({ id, evidence_hash: evidence });
  } catch (err) { next(err); }
});

router.patch('/logistics/assignments/:id/status', requireRole('htx', 'admin', 'partner'), async (req, res, next) => {
  try {
    const status = clean(req.body.status, 40);
    if (!LOGISTICS_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid logistics status' });
    const db = await getDb();
    if (!one(db, 'SELECT id FROM logistics_assignments WHERE id=?', [req.params.id])) return res.status(404).json({ error: 'Assignment not found' });
    const now = new Date().toISOString();
    db.run(`
      UPDATE logistics_assignments
      SET status=?, handoff_at=COALESCE(handoff_at, ?), received_at=CASE WHEN ? IN ('delivered','processed') THEN COALESCE(received_at, ?) ELSE received_at END, updated_at=?
      WHERE id=?
    `, [status, now, status, now, now, req.params.id]);
    audit(db, req.user.id, 'logistics_assignment', req.params.id, 'status_changed', { status });
    saveDb();
    res.json({ status });
  } catch (err) { next(err); }
});

router.get('/field-applications', auth, async (req, res, next) => {
  try {
    const db = await getDb();
    const mine = req.user.role === 'farmer';
    const data = rows(db, `
      SELECT fa.*, p.name AS product_name, p.category
      FROM field_applications fa
      JOIN products p ON p.id = fa.product_id
      ${mine ? 'WHERE fa.user_id=?' : ''}
      ORDER BY fa.applied_at DESC
    `, mine ? [req.user.id] : []);
    res.json({ data });
  } catch (err) { next(err); }
});

router.post('/field-applications', auth, async (req, res, next) => {
  try {
    const productId = clean(req.body.product_id, 80);
    const quantity = Number(req.body.quantity);
    if (!productId || !clean(req.body.field_location) || !Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'product_id, field_location and positive quantity are required' });
    const db = await getDb();
    const product = one(db, 'SELECT id, return_to_field FROM products WHERE id=?', [productId]);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (!Number(product.return_to_field)) return res.status(400).json({ error: 'This product is not marked as return-to-field' });
    const now = new Date().toISOString();
    const id = uuidv4();
    const evidence = hashPayload('field-application', { productId, userId: req.user.id, quantity, now });
    db.run('INSERT INTO field_applications VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
      id, productId, req.user.id, clean(req.body.field_location), quantity, clean(req.body.unit, 20) || 'kg',
      clean(req.body.application_type, 60) || 'soil_improvement', clean(req.body.expected_benefit, 600) || null,
      clean(req.body.applied_at, 40) || now, evidence, now
    ]);
    db.run("UPDATE products SET status='returned_to_field' WHERE id=?", [productId]);
    audit(db, req.user.id, 'field_application', id, 'created', { productId, quantity });
    saveDb();
    res.status(201).json({ id, evidence_hash: evidence });
  } catch (err) { next(err); }
});

router.get('/certificates', auth, async (req, res, next) => {
  try {
    const db = await getDb();
    const status = clean(req.query.status, 40);
    const filters = status ? 'WHERE status=?' : '';
    res.json({ data: rows(db, `SELECT * FROM certificates ${filters} ORDER BY created_at DESC`, status ? [status] : []) });
  } catch (err) { next(err); }
});

router.post('/certificates', requireRole('htx', 'admin', 'partner'), async (req, res, next) => {
  try {
    const entityType = clean(req.body.entity_type, 40);
    const entityId = clean(req.body.entity_id, 80);
    const certificateType = clean(req.body.certificate_type, 60) || 'green_certificate';
    if (!entityType || !entityId || !clean(req.body.standard) || !clean(req.body.issuer)) return res.status(400).json({ error: 'entity_type, entity_id, standard and issuer are required' });
    const db = await getDb();
    const now = new Date().toISOString();
    const id = uuidv4();
    const evidence = hashPayload('certificate', { entityType, entityId, certificateType, now });
    const certificateNo = clean(req.body.certificate_no, 80) || `GL-CERT-${new Date().getFullYear()}-${id.slice(0, 8).toUpperCase()}`;
    const tx = req.body.blockchain_tx || `tx-${crypto.createHash('sha1').update(evidence).digest('hex').slice(0, 16)}`;
    db.run('INSERT INTO certificates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      id, certificateNo, entityType, entityId, certificateType, clean(req.body.standard), clean(req.body.issuer),
      clean(req.body.status, 30) || 'issued', clean(req.body.scope, 800) || null, clean(req.body.issued_at, 40) || now,
      clean(req.body.valid_until, 40) || null, evidence, tx, now, now
    ]);
    audit(db, req.user.id, 'certificate', id, 'created', { certificateNo, entityType, entityId });
    saveDb();
    res.status(201).json({ id, certificate_no: certificateNo, evidence_hash: evidence, blockchain_tx: tx });
  } catch (err) { next(err); }
});

router.patch('/certificates/:id/status', requireRole('htx', 'admin', 'partner'), async (req, res, next) => {
  try {
    const status = clean(req.body.status, 30);
    if (!CERTIFICATE_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid certificate status' });
    const db = await getDb();
    if (!one(db, 'SELECT id FROM certificates WHERE id=?', [req.params.id])) return res.status(404).json({ error: 'Certificate not found' });
    db.run('UPDATE certificates SET status=?, updated_at=? WHERE id=?', [status, new Date().toISOString(), req.params.id]);
    audit(db, req.user.id, 'certificate', req.params.id, 'status_changed', { status });
    saveDb();
    res.json({ status });
  } catch (err) { next(err); }
});

router.get('/trace/products/:id', auth, async (req, res, next) => {
  try {
    const db = await getDb();
    const product = one(db, `
      SELECT p.*, b.batch_code, r.name AS residue_name, r.residue_type, r.origin, r.location AS residue_location,
             cp.process_name, cp.output_name, cp.market_channel, cp.can_return_to_field
      FROM products p
      LEFT JOIN biomass_batches b ON b.id = p.batch_id
      LEFT JOIN residues r ON r.id = p.source_residue_id
      LEFT JOIN conversion_pathways cp ON cp.id = p.conversion_pathway_id
      WHERE p.id=?
    `, [req.params.id]);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const logistics = rows(db, 'SELECT * FROM logistics_assignments WHERE residue_id=? OR batch_id=? ORDER BY created_at ASC', [product.source_residue_id || '', product.batch_id || '']);
    const fieldApplications = rows(db, 'SELECT * FROM field_applications WHERE product_id=? ORDER BY applied_at DESC', [product.id]);
    const certificates = rows(db, "SELECT * FROM certificates WHERE (entity_type='product' AND entity_id=?) OR (entity_type='carbon_record' AND entity_id=?) ORDER BY created_at DESC", [product.id, product.carbon_record_id || '']);
    res.json({ product, logistics, field_applications: fieldApplications, certificates });
  } catch (err) { next(err); }
});

module.exports = router;
