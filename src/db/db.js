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

module.exports = db;
