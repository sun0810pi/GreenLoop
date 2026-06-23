const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb, saveDb } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
const MANAGERS = ['htx', 'admin', 'partner'];
const BATCH_STATES = ['received', 'scheduled', 'collected', 'processing', 'classified', 'verified', 'closed'];
const TASK_STATES = ['open', 'in_progress', 'blocked', 'done'];

function rows(db, sql, params = []) {
  const stmt = db.prepare(sql); stmt.bind(params); const result = [];
  while (stmt.step()) result.push(stmt.getAsObject());
  stmt.free(); return result;
}
function one(db, sql, params = []) { return rows(db, sql, params)[0] || null; }
function audit(db, actorId, entityType, entityId, action, metadata) {
  db.run('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?)', [uuidv4(), actorId || null, entityType, entityId, action, JSON.stringify(metadata || {}), new Date().toISOString()]);
}
function canOperate(user) { return MANAGERS.includes(user.role); }
function clean(value, max = 160) { return String(value || '').trim().slice(0, max); }
function requireOperationalAccess(req, res, next) {
  if (req.user.role === 'buyer') return res.status(403).json({ error: 'Operational data is not available to carbon buyers' });
  next();
}

router.get('/overview', auth, async (req, res, next) => {
  try {
    const db = await getDb();
    const batchFilter = req.user.role === 'farmer' ? ' WHERE owner_id = ?' : '';
    const batchParams = req.user.role === 'farmer' ? [req.user.id] : [];
    const batch = one(db, `SELECT COUNT(*) AS count, COALESCE(SUM(input_kg),0) AS input_kg FROM biomass_batches${batchFilter}`, batchParams);
    const tasks = one(db, `SELECT COUNT(*) AS count FROM workflow_tasks WHERE status IN ('open','in_progress','blocked')`);
    const routes = one(db, `SELECT COUNT(*) AS count FROM logistics_routes WHERE status IN ('planned','dispatching')`);
    const verification = one(db, `SELECT COUNT(*) AS count FROM verification_cases WHERE status='pending'`);
    res.json({ batches: batch, active_tasks: tasks.count, live_routes: routes.count, pending_verification: verification.count, modules: ['ingestion','workflow','catalog','partner','mrv','passport','logistics','analytics','monetization','verification','compliance'] });
  } catch (err) { next(err); }
});

router.get('/batches', auth, requireOperationalAccess, async (req, res, next) => {
  try {
    const db = await getDb();
    const own = req.user.role === 'farmer';
    const data = rows(db, `SELECT b.*, u.name AS owner_name FROM biomass_batches b JOIN users u ON u.id=b.owner_id${own ? ' WHERE b.owner_id = ?' : ''} ORDER BY b.updated_at DESC`, own ? [req.user.id] : []);
    res.json({ data });
  } catch (err) { next(err); }
});
router.post('/batches', requireRole('farmer', 'htx', 'partner', 'admin'), async (req, res, next) => {
  try {
    const biomassType = clean(req.body.biomass_type, 40); const inputKg = Number(req.body.input_kg);
    if (!['rice_straw','pond_sludge','tram','mixed'].includes(biomassType) || !Number.isFinite(inputKg) || inputKg <= 0) return res.status(400).json({ error: 'Valid biomass_type and positive input_kg are required' });
    const db = await getDb(), now = new Date().toISOString(), id = uuidv4(), code = `GL-${new Date().getFullYear()}-${id.slice(0,8).toUpperCase()}`;
    const custody = 'sha256:' + crypto.createHash('sha256').update(`${id}|${req.user.id}|${inputKg}|${now}`).digest('hex');
    db.run('INSERT INTO biomass_batches VALUES (?,?,?,?,?,?,?,?,?,?)', [id, code, req.user.id, clean(req.body.pickup_id, 80) || null, biomassType, inputKg, 'received', custody, now, now]);
    db.run('INSERT INTO workflow_tasks VALUES (?,?,?,?,?,?,?,?,?)', [uuidv4(), id, 'Validate biomass intake', 'htx', 'open', null, null, now, null]);
    audit(db, req.user.id, 'biomass_batch', id, 'created', { code, inputKg }); saveDb();
    res.status(201).json({ id, batch_code: code, custody_hash: custody, status: 'received' });
  } catch (err) { next(err); }
});
router.patch('/batches/:id/status', requireRole(...MANAGERS), async (req, res, next) => {
  try {
    const status = clean(req.body.status, 30); if (!BATCH_STATES.includes(status)) return res.status(400).json({ error: 'Invalid batch status' });
    const db = await getDb(), batch = one(db, 'SELECT id FROM biomass_batches WHERE id=?', [req.params.id]); if (!batch) return res.status(404).json({ error: 'Batch not found' });
    db.run('UPDATE biomass_batches SET status=?, updated_at=? WHERE id=?', [status, new Date().toISOString(), req.params.id]); audit(db, req.user.id, 'biomass_batch', req.params.id, 'status_changed', { status }); saveDb(); res.json({ status });
  } catch (err) { next(err); }
});
router.post('/batches/import', requireRole('htx','admin','partner'), async (req, res, next) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
    if (!items.length) return res.status(400).json({ error: 'items must contain at least one batch' });
    const db = await getDb(), now = new Date().toISOString(), created = [];
    for (const item of items) {
      const type = clean(item.biomass_type, 40), kg = Number(item.input_kg), ownerId = clean(item.owner_id, 80) || req.user.id;
      if (!['rice_straw','pond_sludge','tram','mixed'].includes(type) || !Number.isFinite(kg) || kg <= 0) continue;
      const id=uuidv4(), code=`GL-${new Date().getFullYear()}-${id.slice(0,8).toUpperCase()}`, custody='sha256:'+crypto.createHash('sha256').update(`${id}|${ownerId}|${kg}|${now}`).digest('hex');
      db.run('INSERT INTO biomass_batches VALUES (?,?,?,?,?,?,?,?,?,?)',[id,code,ownerId,clean(item.pickup_id,80)||null,type,kg,'received',custody,now,now]);
      db.run('INSERT INTO workflow_tasks VALUES (?,?,?,?,?,?,?,?,?)',[uuidv4(),id,'Validate imported biomass intake','htx','open',null,'Created by batch import',now,null]);
      audit(db,req.user.id,'biomass_batch',id,'imported',{code,kg}); created.push({id,batch_code:code});
    }
    saveDb(); res.status(201).json({ created, rejected: items.length-created.length });
  } catch (err) { next(err); }
});

router.post('/iot/readings', requireRole('htx','admin','partner'), async (req,res,next)=>{
  try {
    const station=clean(req.body.station,100), province=clean(req.body.province,50), value=Number(req.body.value_gpl);
    if(!station||!province||!Number.isFinite(value)||value<0||value>80) return res.status(400).json({error:'Valid station, province and value_gpl (0-80) required'});
    const db=await getDb(),now=new Date().toISOString(),id=uuidv4();
    db.run('INSERT INTO salinity_readings (id,station,province,river,value_gpl,recorded_at,source,alert,created_at) VALUES (?,?,?,?,?,?,?,?,?)',[id,station,province,clean(req.body.river,100)||null,value,clean(req.body.recorded_at,40)||now,'iot_sensor',value>=5?1:0,now]);
    audit(db,req.user.id,'sensor_reading',id,'ingested',{station,province,value_gpl:value});saveDb();res.status(201).json({id,alert:value>=5});
  } catch(err){next(err);}
});

const ENVIRONMENT_METRICS = {
  salinity: { unit: 'g/L', min: 0, max: 80, alert: v => v >= 5 },
  ph: { unit: 'pH', min: 0, max: 14, alert: v => v < 6 || v > 8.5 },
  dissolved_oxygen: { unit: 'mg/L', min: 0, max: 30, alert: v => v < 4 },
  temperature: { unit: '°C', min: -5, max: 60, alert: v => v < 20 || v > 34 },
  organic_matter: { unit: '%', min: 0, max: 100, alert: v => v < 2 },
  moisture: { unit: '%', min: 0, max: 100, alert: v => v < 35 }
};
router.get('/environment/readings', auth, async (req,res,next)=>{try{
  const db=await getDb(), metric=clean(req.query.metric,40), limit=Math.min(Math.max(Number(req.query.limit)||30,1),100);
  const mine=req.user.role==='farmer'; const sql=`SELECT * FROM environmental_readings ${mine?'WHERE user_id=?':metric?'WHERE metric=?':''} ORDER BY sampled_at DESC LIMIT ${limit}`;
  res.json({data:rows(db,sql,mine?[req.user.id]:metric?[metric]:[])});
}catch(err){next(err);}});
router.post('/environment/readings', auth, async (req,res,next)=>{try{
  const metric=clean(req.body.metric,40), cfg=ENVIRONMENT_METRICS[metric], value=Number(req.body.value);
  if(!cfg || !Number.isFinite(value) || value<cfg.min || value>cfg.max) return res.status(400).json({error:'Valid metric and value are required'});
  const db=await getDb(),now=new Date().toISOString(),id=uuidv4(),station=clean(req.body.station,100)||'Farm measurement',province=clean(req.body.province,50)||req.user.province||'other';
  db.run('INSERT INTO environmental_readings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[id,req.user.id,station,province,metric,value,cfg.unit,clean(req.body.sampled_at,40)||now,clean(req.body.source,30)||'manual',cfg.alert(value)?1:0,now]);
  audit(db,req.user.id,'environmental_reading',id,'recorded',{metric,value,unit:cfg.unit});saveDb();res.status(201).json({id,metric,value,unit:cfg.unit,alert:cfg.alert(value)});
}catch(err){next(err);}});

router.get('/mrv/soil-samples', auth, async (req,res,next)=>{try{const db=await getDb();const mine=req.user.role==='farmer';res.json({data:rows(db,`SELECT * FROM soil_samples ${mine?'WHERE user_id=?':''} ORDER BY sampled_at DESC LIMIT 50`,mine?[req.user.id]:[])});}catch(err){next(err);}});
router.post('/mrv/soil-samples', auth, async (req,res,next)=>{try{
  const values=['ph','organic_matter_pct','moisture_pct','soil_carbon_pct'].reduce((a,k)=>{const v=Number(req.body[k]);a[k]=Number.isFinite(v)?v:null;return a;},{});
  if(Object.values(values).every(v=>v===null)||(values.ph!==null&&(values.ph<0||values.ph>14))||['organic_matter_pct','moisture_pct','soil_carbon_pct'].some(k=>values[k]!==null&&(values[k]<0||values[k]>100))) return res.status(400).json({error:'Provide at least one valid soil measurement'});
  const db=await getDb(),now=new Date().toISOString(),id=uuidv4(),evidence='sha256:'+crypto.createHash('sha256').update(`${req.user.id}|${JSON.stringify(values)}|${now}`).digest('hex');
  db.run('INSERT INTO soil_samples VALUES (?,?,?,?,?,?,?,?,?,?,?)',[id,req.user.id,values.ph,values.organic_matter_pct,values.moisture_pct,values.soil_carbon_pct,clean(req.body.lab_name,100)||'Field sample',evidence,clean(req.body.sampled_at,40)||now,now]);
  audit(db,req.user.id,'soil_sample',id,'recorded',{...values,evidence});saveDb();res.status(201).json({id,evidence_hash:evidence});
}catch(err){next(err);}});

router.get('/refinery/runs', auth, requireOperationalAccess, async (req,res,next)=>{try{const db=await getDb();res.json({data:rows(db,'SELECT r.*,b.batch_code FROM refinery_runs r JOIN biomass_batches b ON b.id=r.batch_id ORDER BY r.started_at DESC')});}catch(err){next(err);}});
router.post('/refinery/runs', requireRole(...MANAGERS), async (req,res,next)=>{try{
  const batchId=clean(req.body.batch_id,80),process=clean(req.body.process,60),input=Number(req.body.input_kg),output=req.body.output_kg===undefined?null:Number(req.body.output_kg),status=clean(req.body.status,20)||'planned';
  if(!batchId||!process||!Number.isFinite(input)||input<=0||(output!==null&&(!Number.isFinite(output)||output<0))||!['planned','running','completed','failed'].includes(status)) return res.status(400).json({error:'Valid refinery run fields are required'});
  const db=await getDb(),batch=one(db,'SELECT id FROM biomass_batches WHERE id=?',[batchId]);if(!batch)return res.status(404).json({error:'Batch not found'});const now=new Date().toISOString(),id=uuidv4();
  db.run('INSERT INTO refinery_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,batchId,process,input,output,clean(req.body.output_type,60)||null,clean(req.body.quality_grade,30)||null,status,clean(req.body.notes,600)||null,now,status==='completed'?now:null,now]);
  db.run('UPDATE biomass_batches SET status=?,updated_at=? WHERE id=?',[status==='completed'?'classified':'processing',now,batchId]);audit(db,req.user.id,'refinery_run',id,'created',{batchId,process,input,output});saveDb();res.status(201).json({id,status});
}catch(err){next(err);}});

router.get('/finance/applications', auth, async (req,res,next)=>{try{const db=await getDb();const mine=req.user.role==='farmer';res.json({data:rows(db,`SELECT * FROM finance_applications ${mine?'WHERE user_id=?':''} ORDER BY created_at DESC`,mine?[req.user.id]:[])});}catch(err){next(err);}});
router.post('/finance/applications', auth, async (req,res,next)=>{try{
  const product=clean(req.body.product_type,30),amount=Number(req.body.amount_vnd),purpose=clean(req.body.purpose,500);if(!['credit','insurance'].includes(product)||!Number.isFinite(amount)||amount<=0||!purpose)return res.status(400).json({error:'Valid product_type, amount_vnd and purpose are required'});
  const db=await getDb(),carbon=one(db,'SELECT COALESCE(SUM(co2e_tonnes),0) AS value FROM carbon_records WHERE user_id=?',[req.user.id]),samples=one(db,'SELECT COUNT(*) AS value FROM soil_samples WHERE user_id=?',[req.user.id]),readings=one(db,'SELECT COUNT(*) AS value FROM environmental_readings WHERE user_id=?',[req.user.id]);
  const score=Math.min(100,Math.round(35+Number(carbon.value)*10+Number(samples.value)*12+Math.min(Number(readings.value),10)*3));const now=new Date().toISOString(),id=uuidv4(),evidence='sha256:'+crypto.createHash('sha256').update(`${req.user.id}|${product}|${amount}|${score}|${now}`).digest('hex');
  db.run('INSERT INTO finance_applications VALUES (?,?,?,?,?,?,?,?,?,?)',[id,req.user.id,product,amount,purpose,score,'submitted',evidence,now,now]);audit(db,req.user.id,'finance_application',id,'submitted',{product,amount,score});saveDb();res.status(201).json({id,status:'submitted',readiness_score:score,evidence_hash:evidence});
}catch(err){next(err);}});

router.get('/tasks', auth, requireOperationalAccess, async (req, res, next) => { try { const db=await getDb(); const isFarmer=req.user.role==='farmer', isPartner=req.user.role==='partner'; const where=isFarmer?'WHERE b.owner_id=?':isPartner?'WHERE t.assignee_role=?':''; const params=isFarmer?[req.user.id]:isPartner?['partner']:[]; const data=rows(db, `SELECT t.*, b.batch_code FROM workflow_tasks t LEFT JOIN biomass_batches b ON b.id=t.batch_id ${where} ORDER BY CASE t.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, t.due_at`, params); res.json({data}); } catch(err){next(err);} });
router.post('/tasks', requireRole(...MANAGERS), async (req,res,next)=>{ try { const title=clean(req.body.title); const role=clean(req.body.assignee_role,40); if(!title || !['farmer','htx','partner','admin','logistics'].includes(role)) return res.status(400).json({error:'Valid title and assignee_role required'}); const db=await getDb(), now=new Date().toISOString(), id=uuidv4(); db.run('INSERT INTO workflow_tasks VALUES (?,?,?,?,?,?,?,?,?)',[id,clean(req.body.batch_id,80)||null,title,role,'open',clean(req.body.due_at,40)||null,clean(req.body.notes,600)||null,now,null]); audit(db,req.user.id,'workflow_task',id,'created',{title,role}); saveDb(); res.status(201).json({id,status:'open'}); }catch(err){next(err);} });
router.patch('/tasks/:id', requireRole(...MANAGERS), async (req,res,next)=>{ try { const status=clean(req.body.status,30); if(!TASK_STATES.includes(status)) return res.status(400).json({error:'Invalid task status'}); const db=await getDb(), task=one(db,'SELECT assignee_role FROM workflow_tasks WHERE id=?',[req.params.id]); if(!task)return res.status(404).json({error:'Task not found'}); if(req.user.role==='partner' && task.assignee_role!=='partner')return res.status(403).json({error:'Partners can only update their assigned tasks'}); const done=status==='done'?new Date().toISOString():null; db.run('UPDATE workflow_tasks SET status=?, completed_at=? WHERE id=?',[status,done,req.params.id]); audit(db,req.user.id,'workflow_task',req.params.id,'status_changed',{status}); saveDb(); res.json({status}); }catch(err){next(err);} });

router.get('/products', auth, async (req,res,next)=>{ try { const db=await getDb(); res.json({data:rows(db,'SELECT p.*, b.batch_code FROM products p LEFT JOIN biomass_batches b ON b.id=p.batch_id WHERE p.status != ? ORDER BY p.created_at DESC',['archived'])}); }catch(err){next(err);} });
router.post('/products', requireRole(...MANAGERS), async (req,res,next)=>{ try { const name=clean(req.body.name), quantity=Number(req.body.quantity_kg), price=Number(req.body.unit_price_vnd); if(!name||!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(price)||price<0) return res.status(400).json({error:'Valid name, quantity_kg and unit_price_vnd required'}); const db=await getDb(),id=uuidv4(),now=new Date().toISOString(); db.run('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?)',[id,clean(req.body.batch_id,80)||null,name,clean(req.body.category,40)||'biochar',quantity,price,'available',clean(req.body.carbon_record_id,80)||null,now]); audit(db,req.user.id,'product',id,'listed',{name,quantity});saveDb();res.status(201).json({id,status:'available'}); }catch(err){next(err);} });

router.get('/partners', auth, requireOperationalAccess, async (req,res,next)=>{try{const db=await getDb();res.json({data:rows(db,'SELECT * FROM partners ORDER BY name')});}catch(err){next(err);}});
router.post('/partners/requests', auth, async (req,res,next)=>{try{const partnerId=clean(req.body.partner_id,80), type=clean(req.body.request_type,50);if(!partnerId||!type)return res.status(400).json({error:'partner_id and request_type required'});const db=await getDb(),partner=one(db,'SELECT id FROM partners WHERE id=?',[partnerId]);if(!partner)return res.status(404).json({error:'Partner not found'});const id=uuidv4(),now=new Date().toISOString();db.run('INSERT INTO partner_requests VALUES (?,?,?,?,?,?,?)',[id,partnerId,type,JSON.stringify(req.body.payload||{}),'new',now,now]);audit(db,req.user.id,'partner_request',id,'created',{partnerId,type});saveDb();res.status(201).json({id,status:'new'});}catch(err){next(err);}});
router.get('/partners/:id/export', requireRole(...MANAGERS), async (req,res,next)=>{try{const db=await getDb(),partner=one(db,'SELECT * FROM partners WHERE id=?',[req.params.id]);if(!partner)return res.status(404).json({error:'Partner not found'});const requests=rows(db,'SELECT * FROM partner_requests WHERE partner_id=? ORDER BY created_at DESC',[req.params.id]);res.json({exported_at:new Date().toISOString(),partner,requests,products:rows(db,"SELECT * FROM products WHERE status='available' ORDER BY created_at DESC")});}catch(err){next(err);}});

router.get('/logistics/routes', auth, requireOperationalAccess, async (req,res,next)=>{try{const db=await getDb();res.json({data:rows(db,'SELECT * FROM logistics_routes ORDER BY scheduled_at')});}catch(err){next(err);}});
router.post('/logistics/routes', requireRole('htx','admin'), async (req,res,next)=>{try{const cap=Number(req.body.capacity_kg),cost=Number(req.body.cost_per_ton_vnd);if(!clean(req.body.route_name)||!clean(req.body.province)||!clean(req.body.scheduled_at)||!Number.isFinite(cap)||cap<=0||!Number.isFinite(cost)||cost<0)return res.status(400).json({error:'Valid route fields required'});const db=await getDb(),id=uuidv4(),now=new Date().toISOString();db.run('INSERT INTO logistics_routes VALUES (?,?,?,?,?,?,?,?,?)',[id,clean(req.body.route_name),clean(req.body.province,50),clean(req.body.scheduled_at,40),cap,0,cost,'planned',now]);audit(db,req.user.id,'logistics_route',id,'created',{});saveDb();res.status(201).json({id,status:'planned'});}catch(err){next(err);}});

router.get('/passport/me', auth, async (req,res,next)=>{try{const db=await getDb();const records=rows(db,'SELECT id, co2e_tonnes, status, passport_hash, created_at FROM carbon_records WHERE user_id=? ORDER BY created_at DESC',[req.user.id]);res.json({farmer:{id:req.user.id,name:req.user.name,province:req.user.province},records,qr_payload:`greenloop://passport/${req.user.id}`});}catch(err){next(err);}});
router.get('/verification', requireRole(...MANAGERS), async (req,res,next)=>{try{const db=await getDb();res.json({data:rows(db,'SELECT v.*, c.co2e_tonnes, c.passport_hash FROM verification_cases v JOIN carbon_records c ON c.id=v.carbon_id ORDER BY v.created_at DESC')});}catch(err){next(err);}});
router.post('/verification/:carbonId', requireRole('htx','admin','partner'), async (req,res,next)=>{try{const db=await getDb(),record=one(db,'SELECT id FROM carbon_records WHERE id=?',[req.params.carbonId]);if(!record)return res.status(404).json({error:'Carbon record not found'});const now=new Date().toISOString(),id=uuidv4(),validator=clean(req.body.validator,100)||req.user.name,evidence='sha256:'+crypto.createHash('sha256').update(`${req.params.carbonId}|${validator}|${now}`).digest('hex');db.run('INSERT INTO verification_cases VALUES (?,?,?,?,?,?,?,?,?)',[id,req.params.carbonId,'verified',validator,evidence,clean(req.body.notes,600)||null,now,now]);db.run("UPDATE carbon_records SET status='verified', verified_at=? WHERE id=?",[now,req.params.carbonId]);audit(db,req.user.id,'verification',id,'verified',{carbonId:req.params.carbonId});saveDb();res.status(201).json({id,status:'verified',evidence_hash:evidence});}catch(err){next(err);}});

router.get('/credits/offers', auth, async (req,res,next)=>{try{const db=await getDb();res.json({data:rows(db,"SELECT o.*, u.name AS seller_name FROM carbon_offers o JOIN users u ON u.id=o.seller_id WHERE o.status='open' ORDER BY o.created_at DESC")});}catch(err){next(err);}});
router.post('/credits/offers', auth, async (req,res,next)=>{try{const carbonId=clean(req.body.carbon_id,80),tonnes=Number(req.body.tonnes),price=Number(req.body.price_per_tonne_usd);if(!carbonId||!Number.isFinite(tonnes)||tonnes<=0||!Number.isFinite(price)||price<=0)return res.status(400).json({error:'Valid carbon_id, tonnes and price_per_tonne_usd required'});const db=await getDb(),record=one(db,"SELECT id FROM carbon_records WHERE id=? AND user_id=? AND status IN ('verified','issued')",[carbonId,req.user.id]);if(!record)return res.status(403).json({error:'Only verified credits you own can be offered'});const id=uuidv4(),now=new Date().toISOString();db.run('INSERT INTO carbon_offers VALUES (?,?,?,?,?,?,?)',[id,carbonId,req.user.id,tonnes,price,'open',now]);audit(db,req.user.id,'carbon_offer',id,'created',{carbonId,tonnes,price});saveDb();res.status(201).json({id,status:'open'});}catch(err){next(err);}});
router.post('/credits/offers/:id/interests', requireRole('buyer'), async (req,res,next)=>{try{const tonnes=Number(req.body.tonnes),message=clean(req.body.message,600);if(!Number.isFinite(tonnes)||tonnes<=0)return res.status(400).json({error:'A positive quantity is required'});const db=await getDb(),offer=one(db,"SELECT id,tonnes FROM carbon_offers WHERE id=? AND status='open'",[req.params.id]);if(!offer)return res.status(404).json({error:'Open credit offer not found'});if(tonnes>Number(offer.tonnes))return res.status(400).json({error:'Requested quantity exceeds the offer'});const now=new Date().toISOString(),id=uuidv4();db.run('INSERT INTO carbon_trade_requests VALUES (?,?,?,?,?,?,?,?)',[id,offer.id,req.user.id,tonnes,message||null,'pending',now,now]);audit(db,req.user.id,'carbon_trade_request',id,'created',{offerId:offer.id,tonnes});saveDb();res.status(201).json({id,status:'pending'});}catch(err){next(err);}});
router.get('/credits/interests', requireRole('buyer','admin','farmer'), async (req,res,next)=>{try{const db=await getDb();let sql=`SELECT r.*,o.price_per_tonne_usd,o.carbon_id,b.name AS buyer_name,s.name AS seller_name FROM carbon_trade_requests r JOIN carbon_offers o ON o.id=r.offer_id JOIN users b ON b.id=r.buyer_id JOIN users s ON s.id=o.seller_id`,params=[];if(req.user.role==='buyer'){sql+=' WHERE r.buyer_id=?';params=[req.user.id];}else if(req.user.role==='farmer'){sql+=' WHERE o.seller_id=?';params=[req.user.id];}sql+=' ORDER BY r.created_at DESC';res.json({data:rows(db,sql,params)});}catch(err){next(err);}});
router.patch('/credits/interests/:id', requireRole('admin','farmer'), async (req,res,next)=>{try{const status=clean(req.body.status,20);if(!['accepted','rejected','cancelled'].includes(status))return res.status(400).json({error:'Invalid trade request status'});const db=await getDb(),record=one(db,'SELECT r.id,o.seller_id FROM carbon_trade_requests r JOIN carbon_offers o ON o.id=r.offer_id WHERE r.id=?',[req.params.id]);if(!record)return res.status(404).json({error:'Trade request not found'});if(req.user.role==='farmer'&&record.seller_id!==req.user.id)return res.status(403).json({error:'Forbidden'});const now=new Date().toISOString();db.run('UPDATE carbon_trade_requests SET status=?,updated_at=? WHERE id=?',[status,now,record.id]);audit(db,req.user.id,'carbon_trade_request',record.id,'status_changed',{status});saveDb();res.json({status});}catch(err){next(err);}});
router.get('/credits/:carbonId/revenue-split', auth, async (req,res,next)=>{try{const db=await getDb(),record=one(db,'SELECT revenue_usd,user_id FROM carbon_records WHERE id=?',[req.params.carbonId]);if(!record)return res.status(404).json({error:'Carbon record not found'});if(req.user.role==='farmer'&&record.user_id!==req.user.id)return res.status(403).json({error:'Forbidden'});const total=Number(record.revenue_usd)||0;res.json({total_usd:total,model:{farmer:{percent:70,amount_usd:Number((total*.7).toFixed(2))},htx:{percent:20,amount_usd:Number((total*.2).toFixed(2))},platform:{percent:10,amount_usd:Number((total*.1).toFixed(2))}}});}catch(err){next(err);}});

router.get('/analytics/regions', auth, async (req,res,next)=>{try{const db=await getDb();const data=rows(db,`SELECT p.province, COUNT(DISTINCT p.id) AS pickups, COALESCE(SUM(p.quantity_kg),0) AS biomass_kg, COALESCE(SUM(c.co2e_tonnes),0) AS co2e_tonnes, AVG(s.value_gpl) AS avg_salinity_gpl FROM pickups p LEFT JOIN carbon_records c ON c.pickup_id=p.id LEFT JOIN salinity_readings s ON s.province=p.province GROUP BY p.province ORDER BY biomass_kg DESC`);res.json({data});}catch(err){next(err);}});

router.get('/compliance', auth, async (_req,res,next)=>{try{res.json({framework:'Verra VM0044',checks:[{id:'custody',label:'Biomass chain of custody',status:'required'},{id:'mass',label:'Weighbridge mass evidence',status:'required'},{id:'lab',label:'EBC laboratory analysis',status:'required'},{id:'validation',label:'Third-party verification',status:'required'},{id:'issuance',label:'Carbon registry issuance',status:'required'}]});}catch(err){next(err);}});

const ECOSYSTEM_CATALOG = {
  zones: [
    { id:'saline_stable', name:'Vùng I - Mặn ổn định', salinity:'>10 permille', model:'Thủy sản mặn, rừng tràm chịu mặn và sinh vật ven biển', species:['shrimp','crab','clam','oyster','seaweed'] },
    { id:'brackish_transition', name:'Vùng II - Mặn lợ chuyển tiếp', salinity:'4-10 permille', model:'Lúa - thủy sản - tràm, đa dạng hóa đối tượng nuôi', species:['shrimp','crab','mudskipper','mullet','blood_cockle'] },
    { id:'fresh_brackish', name:'Vùng III - Lợ ngọt linh hoạt', salinity:'1-4 permille', model:'Lúa - thủy sản nước ngọt, thích ứng theo mùa', species:['giant_freshwater_prawn','tilapia','red_tilapia'] },
    { id:'fresh_stable', name:'Vùng IV - Ngọt ổn định', salinity:'<1 permille', model:'Lúa và thủy sản nước ngọt tuần hoàn', species:['pangasius','tilapia','eel','snakehead'] }
  ],
  species: [
    { id:'shrimp', name:'Tôm', residue:'Vỏ, đầu và bùn hữu cơ', note:'Giá trị xuất khẩu cao; cần quản lý nước ổn định.' },
    { id:'crab', name:'Cua biển', residue:'Vỏ cua và bùn ao', note:'Phù hợp nước lợ/mặn; có thể nuôi xen.' },
    { id:'clam', name:'Nghêu', residue:'Vỏ nhuyễn thể', note:'Chi phí thức ăn thấp, phù hợp bãi triều.' },
    { id:'oyster', name:'Hàu', residue:'Vỏ hàu', note:'Hỗ trợ lọc nước; phù hợp cửa sông.' },
    { id:'mudskipper', name:'Cá kèo', residue:'Bùn hữu cơ ao nuôi', note:'Chịu mặn tốt, phù hợp ao chuyển đổi.' },
    { id:'mullet', name:'Cá đối mục', residue:'Bùn hữu cơ và phụ phẩm cá', note:'Tận dụng thức ăn tự nhiên, hỗ trợ làm sạch ao.' },
    { id:'giant_freshwater_prawn', name:'Tôm càng xanh', residue:'Vỏ và bùn hữu cơ', note:'Kết hợp tốt với lúa vùng ngọt/lợ nhẹ.' },
    { id:'tilapia', name:'Cá rô phi', residue:'Bùn hữu cơ và phụ phẩm cá', note:'Dễ nuôi, chịu môi trường tốt.' },
    { id:'pangasius', name:'Cá tra', residue:'Bùn hữu cơ và phụ phẩm cá', note:'Chuỗi xuất khẩu lớn tại vùng nước ngọt.' },
    { id:'eel', name:'Lươn', residue:'Bùn hữu cơ nhẹ', note:'Giá trị cao, phù hợp diện tích nhỏ.' },
    { id:'snakehead', name:'Cá lóc', residue:'Phụ phẩm cá', note:'Phù hợp nông hộ vùng nước ngọt.' }
  ],
  refinery: [
    { input:'Rơm rạ, bùn ao và sinh khối hữu cơ', process:'Nhiệt phân yếm khí', output:'Biochar, khí và dầu sinh học', value:'Cải tạo đất, lưu trữ carbon' },
    { input:'Lá tràm, cành nhỏ, gỗ tỉa thưa', process:'Tách cellulose và định hình LCNF', output:'Khay xuất khẩu, bao bì sinh học, tấm chống sốc, màng phủ, composite', value:'Thay thế vật liệu không bền vững' },
    { input:'Vỏ, đầu và bùn hữu cơ thủy sản', process:'Tách chitin và xử lý vi sinh', output:'Chitin/chitosan, compost và nguyên liệu sinh học', value:'Tận dụng dinh dưỡng, giảm chất thải' }
  ]
};
router.get('/ecosystem/profile', auth, async (req,res,next)=>{try{const db=await getDb();const profile=one(db,'SELECT * FROM farm_ecosystem_profiles WHERE user_id=?',[req.user.id]);res.json({profile,catalog:ECOSYSTEM_CATALOG});}catch(err){next(err);}});
router.put('/ecosystem/profile', auth, async (req,res,next)=>{try{const zone=clean(req.body.zone_code,40), aquatic=clean(req.body.aquatic_system,80), forest=Number(req.body.melaleuca_ha), practices=Array.isArray(req.body.practices)?req.body.practices.slice(0,10).map(x=>clean(x,40)):[];if(!ECOSYSTEM_CATALOG.zones.some(x=>x.id===zone)||!ECOSYSTEM_CATALOG.species.some(x=>x.id===aquatic)||!Number.isFinite(forest)||forest<0)return res.status(400).json({error:'Valid ecosystem profile required'});const db=await getDb(),now=new Date().toISOString(),existing=one(db,'SELECT id FROM farm_ecosystem_profiles WHERE user_id=?',[req.user.id]);if(existing)db.run('UPDATE farm_ecosystem_profiles SET zone_code=?,aquatic_system=?,melaleuca_ha=?,practices=?,updated_at=? WHERE user_id=?',[zone,aquatic,forest,JSON.stringify(practices),now,req.user.id]);else db.run('INSERT INTO farm_ecosystem_profiles VALUES (?,?,?,?,?,?,?)',[uuidv4(),req.user.id,zone,aquatic,forest,JSON.stringify(practices),now]);audit(db,req.user.id,'ecosystem_profile',req.user.id,'updated',{zone,aquatic,forest});saveDb();res.json({message:'Ecosystem profile saved'});}catch(err){next(err);}});
module.exports = router;
