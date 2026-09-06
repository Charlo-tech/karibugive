/**
 * Causes — DB-backed charity causes with max 3 active.
 * Replaces hardcoded array per spec option: "Table `causes` (can be a hardcoded JS array instead of a DB table)"
 * Now persistent in SQLite so admin can add/manage and enforce active limit.
 */
const db = require('./db');

const MAX_ACTIVE = 3;

function slugify(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'cause-' + Date.now();
}

function getAllCauses() {
  return db.prepare('SELECT * FROM causes ORDER BY created_at ASC, rowid ASC').all();
}

function getActiveCauses() {
  return db.prepare('SELECT * FROM causes WHERE is_active=1 ORDER BY created_at ASC, rowid ASC').all();
}

function getCauseById(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM causes WHERE id = ?').get(id) || null;
}

function getCauseByIndex(index) {
  // 1-based index into ACTIVE causes only — matches USSD menu which lists active only
  const active = getActiveCauses();
  return active[index - 1] || null;
}

function countActive() {
  return db.prepare('SELECT COUNT(*) as c FROM causes WHERE is_active=1').get().c;
}

function createCause({ name, description, target_amount, emoji, is_active }) {
  if (!name || !String(name).trim()) throw new Error('Cause name is required');
  const cleanName = String(name).trim();
  const idBase = slugify(cleanName);
  let id = idBase;
  // Ensure unique id
  let suffix = 1;
  while (getCauseById(id)) {
    suffix += 1;
    id = `${idBase}-${suffix}`;
  }
  const tAmt = parseInt(target_amount, 10);
  if (isNaN(tAmt) || tAmt < 1000) throw new Error('Target amount must be at least 1000');
  const active = is_active ? 1 : 0;
  if (active && countActive() >= MAX_ACTIVE) {
    throw new Error(`Only ${MAX_ACTIVE} causes can be active at a time. Deactivate one before activating this.`);
  }
  const desc = description ? String(description).trim() : '';
  const em = emoji ? String(emoji).trim().slice(0, 4) : '❤️';
  db.prepare('INSERT INTO causes (id, name, description, target_amount, emoji, is_active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, cleanName, desc, tAmt, em, active);
  return getCauseById(id);
}

function updateCause(id, { name, description, target_amount, emoji }) {
  const existing = getCauseById(id);
  if (!existing) throw new Error('Cause not found');
  const newName = name !== undefined ? String(name).trim() : existing.name;
  if (!newName) throw new Error('Name required');
  const tAmt = target_amount !== undefined ? parseInt(target_amount, 10) : existing.target_amount;
  if (isNaN(tAmt) || tAmt < 1000) throw new Error('Target amount must be at least 1000');
  const desc = description !== undefined ? String(description).trim() : existing.description;
  const em = emoji !== undefined ? String(emoji).trim().slice(0, 4) || existing.emoji : existing.emoji;
  db.prepare('UPDATE causes SET name=?, description=?, target_amount=?, emoji=? WHERE id=?')
    .run(newName, desc, tAmt, em, id);
  return getCauseById(id);
}

function setActive(id, shouldActive) {
  const existing = getCauseById(id);
  if (!existing) throw new Error('Cause not found');
  const want = shouldActive ? 1 : 0;
  if (want === existing.is_active) return existing;
  if (want === 1 && countActive() >= MAX_ACTIVE) {
    throw new Error(`Cannot activate — already ${MAX_ACTIVE} active causes. Deactivate another first.`);
  }
  db.prepare('UPDATE causes SET is_active=? WHERE id=?').run(want, id);
  return getCauseById(id);
}

function deleteCause(id) {
  const existing = getCauseById(id);
  if (!existing) throw new Error('Cause not found');
  // Prevent deleting a cause that has donations (would orphan history)
  const donationsCount = db.prepare('SELECT COUNT(*) as c FROM donations WHERE cause_id=?').get(id).c;
  if (donationsCount > 0) {
    throw new Error(`Cannot delete — ${donationsCount} donation(s) reference this cause. Deactivate instead.`);
  }
  db.prepare('DELETE FROM causes WHERE id=?').run(id);
  return true;
}

// Keep backward compat: `causes` was previously exported hardcoded array.
// Now it's a live getter — using a Proxy to always reflect DB.
const causesProxy = new Proxy([], {
  get(target, prop) {
    if (prop === 'length') return getAllCauses().length;
    if (prop === Symbol.iterator) return getAllCauses()[Symbol.iterator].bind(getAllCauses());
    if (typeof prop === 'string' && !isNaN(prop)) return getAllCauses()[Number(prop)];
    if (prop === 'map' || prop === 'forEach' || prop === 'find' || prop === 'filter' || prop === 'slice') {
      const arr = getAllCauses();
      return arr[prop].bind(arr);
    }
    return getAllCauses()[prop];
  }
});

module.exports = {
  causes: causesProxy,
  getAllCauses,
  getActiveCauses,
  getCauseById,
  getCauseByIndex,
  countActive,
  createCause,
  updateCause,
  setActive,
  deleteCause,
  MAX_ACTIVE,
};
