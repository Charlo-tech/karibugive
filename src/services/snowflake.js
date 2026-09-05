/**
 * Snowflake service — secondary analytics store
 * https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver
 * https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-connect
 * https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-execute
 * https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-consume
 *
 * Implements the exact driver workflow documented by Snowflake:
 *   1. snowflake.createConnection({ account, username, password, warehouse, database, schema, role, application })
 *   2. connection.connect((err, conn) => { ... })
 *   3. connection.execute({ sqlText, binds, complete: (err, stmt, rows) => {} })
 *
 * - syncDonationToSnowflake(donationRow) — INSERT hashed PII into DONATIONS_ANALYTICS
 * - syncUnsyncedBatch() — batch-sync SQLite rows where synced_to_snowflake = 0
 * - getCortexAnalyticsSummary() — aggregate query + SNOWFLAKE.CORTEX.COMPLETE('llama3-8b', ?) via binds
 *
 * Runs in MOCK mode when SNOWFLAKE_* credentials are absent — no network call, SQLite fallback used.
 */

const crypto = require('crypto');

// Lazy singleton per https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-connect#label-create-single-connection
let connection = null;      // holds the connected Connection object once ready
let connectPromise = null;  // in-flight connect Promise — prevents parallel connects
let mockMode = false;

/**
 * Check required credentials per https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-options#label-nodejs-required-options
 * account is the Snowflake account identifier (e.g. "myorg-myaccount" or "myaccount.us-east-2" — region embedded, not separate).
 */
function isConfigured() {
  return !!(
    process.env.SNOWFLAKE_ACCOUNT &&
    process.env.SNOWFLAKE_USERNAME &&
    process.env.SNOWFLAKE_PASSWORD
  );
}

/**
 * Hash phone before syncing — never send raw PII to Snowflake.
 * SHA-256 truncated to 16 hex chars is sufficient for analytics dedupe at this scale.
 */
function hashPhone(phone) {
  if (!phone) return null;
  return crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16);
}

/**
 * Get (or create) a single Snowflake Connection per docs:
 *   const connection = snowflake.createConnection({ account, username, password, ... });
 *   connection.connect((err, conn) => { if (err) ... else ... });
 *
 * Returns: Promise<Connection|null> — null signals MOCK mode.
 * Uses lazy init + ensureTable() DDL on first connect.
 */
function getConnection() {
  if (mockMode) return null;
  if (!isConfigured()) {
    mockMode = true;
    console.warn('[Snowflake] SNOWFLAKE_ACCOUNT/USERNAME/PASSWORD not set — running in MOCK mode (see https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-connect)');
    return null;
  }
  if (connection) return connection;
  if (connectPromise) return connectPromise;

  const snowflake = require('snowflake-sdk');

  // Optional: configure XML parser etc. — not needed for this app, but shown per docs:
  // snowflake.configure({ ... })

  connectPromise = new Promise((resolve, reject) => {
    // Per https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-options#label-nodejs-addl-options
    // warehouse/database/schema/role are optional defaults for the session; if the objects don't exist, no default is set.
    const conn = snowflake.createConnection({
      account: process.env.SNOWFLAKE_ACCOUNT,   // required — e.g. "abc123.us-east-1"
      username: process.env.SNOWFLAKE_USERNAME, // required
      password: process.env.SNOWFLAKE_PASSWORD, // required for authenticator=SNOWFLAKE (default)
      warehouse: process.env.SNOWFLAKE_WAREHOUSE,
      database: process.env.SNOWFLAKE_DATABASE,
      schema: process.env.SNOWFLAKE_SCHEMA,
      role: process.env.SNOWFLAKE_ROLE,
      application: 'KaribuGive',                // per docs: application name for Snowflake partner tracking
      // keepAlive / clientSessionKeepAlive could be set here for long-running apps per docs, but not needed for weekend scale
    });

    // Per docs: connection.connect((err, conn) => { ... })
    conn.connect(async (err, conn) => {
      if (err) {
        console.error('[Snowflake] connection.connect failed — falling back to MOCK:', err.message);
        mockMode = true;
        // Resolve null instead of rejecting so the app keeps running in MOCK mode
        return resolve(null);
      }

      // Optional validity check per https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-connect#label-nodejs-isvalidasync
      try {
        if (typeof conn.isValidAsync === 'function') {
          const valid = await conn.isValidAsync();
          if (!valid) {
            console.warn('[Snowflake] connection.isValidAsync() returned false — using MOCK');
            mockMode = true;
            return resolve(null);
          }
        }
      } catch (_) {
        // ignore — not all driver versions expose isValidAsync
      }

      console.log('[Snowflake] Successfully connected to Snowflake (id=' + conn.getId() + ')');
      connection = conn;

      // Ensure analytics table exists — idempotent DDL, same execute pattern as below
      try {
        await ensureTable(conn);
        resolve(conn);
      } catch (ddlErr) {
        reject(ddlErr);
      }
    });
  });

  return connectPromise;
}

/**
 * Ensure DONATIONS_ANALYTICS exists. Uses connection.execute per
 * https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-execute
 */
function ensureTable(conn) {
  // Per docs: connection.execute({ sqlText, complete: (err, stmt, rows) => {} })
  return new Promise((resolve, reject) => {
    const sqlText = `
      CREATE TABLE IF NOT EXISTS DONATIONS_ANALYTICS (
        id INTEGER,
        phone_hash STRING,
        cause_id STRING,
        amount INTEGER,
        checkout_request_id STRING,
        created_at TIMESTAMP_NTZ,
        completed_at TIMESTAMP_NTZ
      )
    `;
    conn.execute({
      sqlText,
      complete: (err /*, stmt, rows */) => {
        if (err) {
          console.error('[Snowflake] CREATE TABLE failed:', err.message);
          return reject(err);
        }
        resolve();
      }
    });
  });
}

/**
 * Thin Promise wrapper around connection.execute per docs:
 *   connection.execute({ sqlText, binds, complete: (err, stmt, rows) => {} })
 * Also supports the streaming API (stmt.streamRows()) per
 * https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-consume if needed.
 *
 * @param {import('snowflake-sdk').Connection} conn
 * @param {string} sqlText
 * @param {any[]} binds — per https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-execute#label-nodejs-binding
 * @returns {Promise<any[]>} rows
 */
function executeSql(conn, sqlText, binds = []) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds, // '?' placeholders — prevents SQL injection, docs recommend binds over string concat
      complete: (err, stmt, rows) => {
        if (err) return reject(err);
        // rows is the inline result set per https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-consume#returning-results-inline
        // For large sets you could use stmt.streamRows() here, but our analytics rows are tiny.
        resolve(rows);
      }
    });
  });
}

/**
 * Insert a single completed donation into Snowflake. Uses binds for all values
 * per https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-execute#label-nodejs-binding
 */
async function syncDonationToSnowflake(donation) {
  const { markSynced } = require('./donations'); // lazy require to avoid circular init order
  const phone_hash = hashPhone(donation.phone_number);
  const connOrPromise = getConnection();
  const conn = connOrPromise instanceof Promise ? await connOrPromise : connOrPromise;

  if (!conn) {
    console.log(`[Snowflake MOCK] would INSERT donation #${donation.id} cause=${donation.cause_id} amount=${donation.amount} phone_hash=${phone_hash}`);
    // In mock mode we still mark synced to simulate success for the demo; real batch will show mock success
    try { markSynced(donation.id); } catch (_) {}
    return { mock: true, success: true };
  }

  try {
    // Binding array — each '?' is replaced server-side per docs, safe from injection
    await executeSql(
      conn,
      `INSERT INTO DONATIONS_ANALYTICS (id, phone_hash, cause_id, amount, checkout_request_id, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [donation.id, phone_hash, donation.cause_id, donation.amount, donation.checkout_request_id, donation.created_at, donation.completed_at]
    );
    markSynced(donation.id);
    console.log(`[Snowflake] INSERT synced donation #${donation.id} (query via binds)`);
    return { mock: false, success: true };
  } catch (e) {
    console.error(`[Snowflake] INSERT failed for #${donation.id}:`, e.message);
    return { mock: false, success: false, error: e.message };
  }
}

/**
 * Batch-sync any SQLite rows where status='completed' and synced_to_snowflake=0.
 * Synchronous/simple per weekend spec — no queue/Snowpipe.
 */
async function syncUnsyncedBatch() {
  const { getUnsyncedDonations } = require('./donations');
  const rows = getUnsyncedDonations(); // SELECT * FROM donations WHERE status='completed' AND synced_to_snowflake=0
  const results = [];
  for (const r of rows) {
    const res = await syncDonationToSnowflake(r);
    results.push({ id: r.id, ...res });
  }
  return { total: rows.length, results };
}

/* ---------- Cortex AI Analytics (mock fallback shared) ---------- */

function getMockCortexSummary() {
  try {
    const db = require('../db/db');
    const byCause = db.prepare(`SELECT cause_id, COUNT(*) as cnt, SUM(amount) as total, AVG(amount) as avg FROM donations WHERE status='completed' GROUP BY cause_id`).all();
    const total = db.prepare(`SELECT COUNT(*) as c, SUM(amount) as s FROM donations WHERE status='completed'`).get();
    const daily = db.prepare(`SELECT date(completed_at) as d, COUNT(*) as c, SUM(amount) as s FROM donations WHERE status='completed' GROUP BY date(completed_at) ORDER BY d DESC LIMIT 7`).all();
    const largest = db.prepare(`SELECT cause_id, amount FROM donations WHERE status='completed' ORDER BY amount DESC LIMIT 1`).get();

    if (!total || total.c === 0) {
      return {
        mock: true,
        summary: 'No completed donations yet — analytics will appear once payments are confirmed.',
        aggregates: { byCause, total, daily, largest }
      };
    }
    let summary = `Across ${total.c} completed donation(s), KES ${total.s.toLocaleString()} has been raised. `;
    if (byCause.length) {
      const top = [...byCause].sort((a, b) => b.total - a.total)[0];
      summary += `The ${top.cause_id} cause leads with KES ${top.total.toLocaleString()} (${top.cnt} gifts, avg KES ${Math.round(top.avg)}). `;
    }
    if (daily.length >= 2) {
      const latest = daily[0].s || 0;
      const prev = daily[1].s || 1;
      const pct = Math.round(((latest - prev) / prev) * 100);
      if (pct > 0) summary += `Donations grew ${pct}% day-over-day (KES ${prev.toLocaleString()} → KES ${latest.toLocaleString()}). `;
      else if (pct < 0) summary += `Donations dipped ${Math.abs(pct)}% in the last day. `;
    }
    if (largest) summary += `Largest single gift: KES ${largest.amount.toLocaleString()} to ${largest.cause_id}.`;
    summary += ' (Generated locally — Snowflake Cortex mock mode)';
    return { mock: true, summary, aggregates: { byCause, total, daily, largest } };
  } catch (e) {
    return { mock: true, summary: 'Analytics unavailable: ' + e.message, error: e.message };
  }
}

/**
 * Cortex AI Analytics — runs aggregates then asks
 * SNOWFLAKE.CORTEX.COMPLETE('llama3-8b', ?) for a natural-language summary.
 *
 * Per docs we use binds for the model name and prompt to avoid SQL injection:
 *   connection.execute({ sqlText: 'SELECT SNOWFLAKE.CORTEX.COMPLETE(?, ?) as summary', binds: [model, prompt], complete: ... })
 * See https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-execute#label-nodejs-binding
 *
 * The prompt is built from aggregates over DONATIONS_ANALYTICS (totals by cause, daily trend, largest gift).
 * Displayed in the dedicated "Snowflake AI Analytics" card; re-run on demand via "Refresh analytics" to control cost.
 */
async function getCortexAnalyticsSummary() {
  const connOrPromise = getConnection();
  const conn = connOrPromise instanceof Promise ? await connOrPromise : connOrPromise;

  if (!conn) {
    return getMockCortexSummary();
  }

  try {
    // Aggregates — each uses the standard execute path per docs
    const byCause = await executeSql(conn,
      `SELECT cause_id, COUNT(*) as cnt, SUM(amount) as total, AVG(amount) as avg_amt FROM DONATIONS_ANALYTICS GROUP BY cause_id`);
    const total = await executeSql(conn, `SELECT COUNT(*) as c, SUM(amount) as s FROM DONATIONS_ANALYTICS`);
    const daily = await executeSql(conn,
      `SELECT TO_DATE(completed_at) as d, COUNT(*) as c, SUM(amount) as s FROM DONATIONS_ANALYTICS GROUP BY TO_DATE(completed_at) ORDER BY d DESC LIMIT 7`);
    const largest = await executeSql(conn, `SELECT cause_id, amount FROM DONATIONS_ANALYTICS ORDER BY amount DESC LIMIT 1`);

    const aggText = JSON.stringify({ byCause, total, daily, largest });
    const prompt = `You are an analytics assistant for a micro-donation platform. Given these aggregates: ${aggText}. Write a concise 2-3 sentence analytics summary highlighting: which cause is leading, average gift size, day-over-day trend, and largest gift. Keep it donor-friendly.`;

    // Use binds for model + prompt per docs binding example — safer than string interpolation
    const cortexSql = `SELECT SNOWFLAKE.CORTEX.COMPLETE(?, ?) as summary`;
    const rows = await executeSql(conn, cortexSql, ['llama3-8b', prompt]);
    const summary = rows && rows[0] ? (rows[0].SUMMARY || rows[0].summary || Object.values(rows[0])[0]) : 'No summary returned';
    return { mock: false, summary, aggregates: { byCause, total, daily, largest } };
  } catch (e) {
    console.error('[Snowflake Cortex] CORTEX.COMPLETE failed:', e.message);
    const mockFallback = getMockCortexSummary();
    return { mock: true, summary: `Cortex query failed (${e.message}). ` + (mockFallback.summary || ''), error: e.message, aggregates: mockFallback.aggregates };
  }
}

/**
 * Graceful shutdown helper per https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-connect#terminating-a-connection
 * Call on process exit: connection.destroy((err, conn) => { ... })
 */
function destroyConnection() {
  if (connection) {
    connection.destroy((err) => {
      if (err) console.error('[Snowflake] destroy failed:', err.message);
      else console.log('[Snowflake] connection destroyed');
    });
  }
}
if (typeof process !== 'undefined') {
  process.on('SIGINT', destroyConnection);
  process.on('SIGTERM', destroyConnection);
}

module.exports = {
  syncDonationToSnowflake,
  syncUnsyncedBatch,
  getCortexAnalyticsSummary,
  hashPhone,
  isConfigured,
  executeSql,
  getConnection,
  destroyConnection
};
