const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', '..', 'data', 'karibu.db');

// Ensure data directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (e) {
  console.warn('[DB] better-sqlite3 not available, falling back to node:sqlite:', e.message);
  const { DatabaseSync } = require('node:sqlite');
  const native = new DatabaseSync(DB_PATH);
  // Minimal better-sqlite3-like wrapper for our usage: prepare().get/run/all, exec, pragma
  db = {
    _native: native,
    pragma(sql) {
      try { native.exec(`PRAGMA ${sql}`); } catch (_) {}
    },
    exec(sql) { native.exec(sql); },
    prepare(sql) {
      const stmt = native.prepare(sql);
      return {
        get(...params) {
          try { return stmt.get(...params) || null; } catch (err) { // node:sqlite may not support variadic
            // Try binding alternative
            return stmt.get(...params);
          }
        },
        all(...params) {
          return stmt.all(...params);
        },
        run(...params) {
          const info = stmt.run(...params);
          // better-sqlite3 returns { lastInsertRowid, changes }
          return { lastInsertRowid: info.lastInsertRowId ?? info.lastInsertRowid, changes: info.changes };
        }
      };
    },
    // for transaction helpers if needed
    transaction(fn) { return fn; }
  };
}

// Run schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Seed default causes if table is empty (first run / migration from hardcoded list)
try {
  const count = db.prepare('SELECT COUNT(*) as c FROM causes').get().c;
  if (count === 0) {
    console.log('[DB] Seeding default causes (3 active)');
    const seed = [
      { id: 'clean-water', name: 'Clean Water', description: 'Provide clean drinking water to rural communities in Turkana.', target_amount: 500000, emoji: '💧', is_active: 1 },
      { id: 'school-books', name: 'School Books', description: 'Supply textbooks and stationery to primary schools in Kibera.', target_amount: 300000, emoji: '📚', is_active: 1 },
      { id: 'health-clinic', name: 'Health Clinic', description: 'Support mobile health clinics serving remote villages.', target_amount: 750000, emoji: '🏥', is_active: 1 },
    ];
    const stmt = db.prepare('INSERT INTO causes (id, name, description, target_amount, emoji, is_active) VALUES (?, ?, ?, ?, ?, ?)');
    for (const c of seed) {
      stmt.run(c.id, c.name, c.description, c.target_amount, c.emoji, c.is_active);
    }
  } else {
    // Ensure at least 3 active if DB was seeded before is_active column existed (migration)
    // For older DBs where is_active may be null, activate all
    const active = db.prepare('SELECT COUNT(*) as c FROM causes WHERE is_active=1').get().c;
    if (active === 0) {
      db.exec('UPDATE causes SET is_active=1 WHERE id IN (SELECT id FROM causes LIMIT 3)');
      console.log('[DB] Migrated causes: activated first 3');
    }
  }
} catch (e) {
  console.warn('[DB] cause seeding failed', e.message);
}

module.exports = db;
