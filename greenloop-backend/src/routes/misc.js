const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb, saveDb } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
function toObjects(result) {
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

// ─── Notifications ────────────────────────────────────────────────────────────

/**
 * GET /api/notifications — my notifications (own + broadcast)
 */
router.get('/notifications', auth, async (req, res) => {
  try {
    const db = await getDb();
    const { unread } = req.query;
    let where = `WHERE (user_id = '${req.user.id}' OR user_id IS NULL)`;
    if (unread === 'true') where += ' AND read = 0';

    const result = db.exec(`SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT 50`);
    const unreadCount = db.exec(`SELECT COUNT(*) FROM notifications ${where} AND read = 0`);

    res.json({
      data: toObjects(result),
      unread_count: unreadCount[0]?.values[0][0] || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/notifications/read-all — mark all as read
 */
router.patch('/notifications/read-all', auth, async (req, res) => {
  try {
    const db = await getDb();
    db.run(`UPDATE notifications SET read=1 WHERE (user_id='${req.user.id}' OR user_id IS NULL) AND read=0`);
    saveDb();
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/notifications/:id/read
 */
router.patch('/notifications/:id/read', auth, async (req, res) => {
  try {
    const db = await getDb();
    db.run(`UPDATE notifications SET read=1 WHERE id='${req.params.id}'`);
    saveDb();
    res.json({ message: 'Marked as read' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Points ──────────────────────────────────────────────────────────────────

/**
 * GET /api/points — my points history + balance
 */
router.get('/points', auth, async (req, res) => {
  try {
    const db = await getDb();
    const result = db.exec(`SELECT * FROM points WHERE user_id='${req.user.id}' ORDER BY created_at DESC LIMIT 50`);
    const balRes = db.exec(`SELECT SUM(CASE WHEN type='earned' THEN amount ELSE -amount END) FROM points WHERE user_id='${req.user.id}'`);
    const balance = balRes[0]?.values[0][0] || 0;

    res.json({ balance, data: toObjects(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/points/redeem — redeem points for fertiliser voucher
 * Body: { amount, item }  (item: e.g. 'fertiliser_50kg')
 */
router.post('/points/redeem', auth, async (req, res) => {
  try {
    const db = await getDb();
    const { amount, item } = req.body;
    if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum redemption is 100 points' });
    if (!item) return res.status(400).json({ error: 'item required' });

    const balRes = db.exec(`SELECT SUM(CASE WHEN type='earned' THEN amount ELSE -amount END) FROM points WHERE user_id='${req.user.id}'`);
    const balance = balRes[0]?.values[0][0] || 0;
    if (balance < amount) return res.status(400).json({ error: `Insufficient points. Balance: ${balance}` });

    const id = uuidv4();
    const now = new Date().toISOString();
    db.run(`INSERT INTO points (id,user_id,amount,type,reason,ref_id,created_at) VALUES (?,?,?,?,?,?,?)`,
      [id, req.user.id, amount, 'redeemed', `Redeemed for: ${item}`, id, now]);

    // Voucher notification
    db.run(`INSERT INTO notifications (id,user_id,title,body,type,created_at) VALUES (?,?,?,?,?,?)`,
      [uuidv4(), req.user.id,
       '🎟️ Points Redeemed',
       `${amount} pts redeemed for ${item}. Show this to your HTX to collect.`,
       'success', now]);

    saveDb();
    res.status(201).json({
      redemption_id: id,
      points_used: amount,
      new_balance: balance - amount,
      item,
      voucher_code: `GL-${id.slice(0, 8).toUpperCase()}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
