const db = require('../db/db');
const causesMod = require('../db/causes');

/**
 * Donation service — SQLite CRUD helpers
 */

function createDonation({ phone_number, cause_id, amount, checkout_request_id }) {
  const stmt = db.prepare(`
    INSERT INTO donations (phone_number, cause_id, amount, status, checkout_request_id, created_at, synced_to_snowflake)
    VALUES (?, ?, ?, 'pending', ?, datetime('now'), 0)
  `);
  const info = stmt.run(phone_number, cause_id, amount, checkout_request_id || null);
  return getDonationById(info.lastInsertRowid);
}

function getDonationById(id) {
  return db.prepare('SELECT * FROM donations WHERE id = ?').get(id) || null;
}

function getDonationByCheckoutId(checkoutRequestId) {
  return db.prepare('SELECT * FROM donations WHERE checkout_request_id = ?').get(checkoutRequestId) || null;
}

function updateDonationStatus(id, status, { completedAt = null } = {}) {
  if (status === 'completed') {
    db.prepare(`UPDATE donations SET status = ?, completed_at = COALESCE(?, datetime('now')) WHERE id = ?`)
      .run(status, completedAt, id);
  } else {
    db.prepare('UPDATE donations SET status = ? WHERE id = ?').run(status, id);
  }
  return getDonationById(id);
}

function markSynced(id) {
  db.prepare('UPDATE donations SET synced_to_snowflake = 1 WHERE id = ?').run(id);
}

function getUnsyncedDonations() {
  return db.prepare(`SELECT * FROM donations WHERE status = 'completed' AND synced_to_snowflake = 0`).all();
}

function getAllDonations({ status, cause_id } = {}) {
  let sql = 'SELECT * FROM donations WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (cause_id) { sql += ' AND cause_id = ?'; params.push(cause_id); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}

function getStats() {
  const totalRaised = db.prepare(`SELECT COALESCE(SUM(amount),0) as sum FROM donations WHERE status='completed'`).get().sum;
  const totalDonations = db.prepare('SELECT COUNT(*) as c FROM donations').get().c;
  const completed = db.prepare(`SELECT COUNT(*) as c FROM donations WHERE status='completed'`).get().c;
  const pending = db.prepare(`SELECT COUNT(*) as c FROM donations WHERE status='pending'`).get().c;
  const failed = db.prepare(`SELECT COUNT(*) as c FROM donations WHERE status='failed'`).get().c;
  return { totalRaised, totalDonations, completed, pending, failed };
}

function getRaisedByCause({ activeOnly = false } = {}) {
  const rows = db.prepare(`
    SELECT cause_id, COALESCE(SUM(amount),0) as raised, COUNT(*) as count
    FROM donations WHERE status='completed' GROUP BY cause_id
  `).all();
  const map = {};
  for (const r of rows) map[r.cause_id] = r;
  const causes = activeOnly ? causesMod.getActiveCauses() : causesMod.getAllCauses();
  return causes.map(c => ({
    ...c,
    raised: map[c.id]?.raised || 0,
    count: map[c.id]?.count || 0,
    progress: c.target_amount ? Math.min(100, Math.round(((map[c.id]?.raised || 0) / c.target_amount) * 100)) : 0
  }));
}

function getRecentCompleted(limit = 20) {
  return db.prepare(`SELECT * FROM donations WHERE status='completed' ORDER BY completed_at DESC LIMIT ?`).all(limit);
}

module.exports = {
  createDonation,
  getDonationById,
  getDonationByCheckoutId,
  updateDonationStatus,
  markSynced,
  getUnsyncedDonations,
  getAllDonations,
  getStats,
  getRaisedByCause,
  getRecentCompleted
};
