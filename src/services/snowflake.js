/**
 * Snowflake service — secondary analytics store
 * - syncDonationToSnowflake(donationRow)
 * - syncUnsyncedBatch()
 * - getCortexAnalyticsSummary()
 *
 * Runs in mock mode when Snowflake env vars are missing — logs instead of inserting.
 */
const crypto = require('crypto');
const { markSynced, getUnsyncedDonations } = require('./donations');

// Lazy snowflake connection
let connection = null;
let connectPromise = null;
let mockMode = false;

function isConfigured() {
  return !!(
    process.env.SNOWFLAKE_ACCOUNT &&
    process.env.SNOWFLAKE_USERNAME &&
    process.env.SNOWFLAKE_PASSWORD
  );
}

function hashPhone(phone) {
  // SHA256 truncated — don't send raw PII to Snowflake
  if (!phone) return null;
  return crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16);
}

function getConnection() {
  if (mockMode) return null;
  if (!isConfigured()) {
    mockMode = true;
    console.warn('[Snowflake] Missing credentials — running in MOCK mode');
    return null;
  }
  if (connection) return connection;
  if (connectPromise) return connectPromise;

  const snowflake = require('snowflake-sdk');
  connectPromise = new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account: process.env.SNOWFLAKE_ACCOUNT,
      username: process.env.SNOWFLAKE_USERNAME,
      password: process.env.SNOWFLAKE_PASSWORD,
      warehouse: process.env.SNOWFLAKE_WAREHOUSE,
      database: process.env.SNOWFLAKE_DATABASE,
      schema: process.env.SNOWFLAKE_SCHEMA,
      role: process.env.SNOWFLAKE_ROLE
    });
    conn.connect((err) => {
      if (err) {
        console.error('[Snowflake] connect failed', err.message);
        mockMode = true;
        // Resolve as mock instead of rejecting so app keeps running
        resolve(null);
      } else {
        console.log('[Snowflake] connected');
        connection = conn;
        // Ensure table exists
        ensureTable(conn).then(() => resolve(conn)).catch(reject);
      }
    });
  });
  return connectPromise;
}

function ensureTable(conn) {
  return new Promise((resolve, reject) => {
    const sql = `
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
      sqlText: sql,
      complete: (err) => {
        if (err) { console.error('[Snowflake] ensureTable error', err.message); return reject(err); }
        resolve();
      }
    });
  });
}

function executeSql(conn, sqlText, binds = []) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, stmt, rows) => {
        if (err) return reject(err);
        resolve(rows);
      }
    });
  });
}

async function syncDonationToSnowflake(donation) {
  // donation is SQLite row
  const phone_hash = hashPhone(donation.phone_number);
  const connOrPromise = getConnection();
  const conn = connOrPromise instanceof Promise ? await connOrPromise : connOrPromise;
  if (!conn) {
    console.log(`[Snowflake MOCK] would insert donation #${donation.id} cause=${donation.cause_id} amount=${donation.amount} phone_hash=${phone_hash}`);
    // In mock mode, mark as synced so batch doesn't retry forever? No — keep false to show batch sync works.
    // But for demo we mark synced to avoid clutter. We'll mark synced in mock to simulate success.
    try { markSynced(donation.id); } catch (_) {}
    return { mock: true, success: true };
  }
  try {
    await executeSql(conn,
      `INSERT INTO DONATIONS_ANALYTICS (id, phone_hash, cause_id, amount, checkout_request_id, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [donation.id, phone_hash, donation.cause_id, donation.amount, donation.checkout_request_id, donation.created_at, donation.completed_at]
    );
    markSynced(donation.id);
    console.log(`[Snowflake] synced donation #${donation.id}`);
    return { mock: false, success: true };
  } catch (e) {
    console.error(`[Snowflake] insert failed for #${donation.id}`, e.message);
    return { mock: false, success: false, error: e.message };
  }
}

async function syncUnsyncedBatch() {
  const rows = getUnsyncedDonations();
  const results = [];
  for (const r of rows) {
    const res = await syncDonationToSnowflake(r);
    results.push({ id: r.id, ...res });
  }
  return { total: rows.length, results };
}

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
      const top = [...byCause].sort((a,b)=>b.total-a.total)[0];
      summary += `The ${top.cause_id} cause leads with KES ${top.total.toLocaleString()} (${top.cnt} gifts, avg KES ${Math.round(top.avg)}). `;
    }
    if (daily.length >= 2) {
      const latest = daily[0].s || 0;
      const prev = daily[1].s || 1;
      const pct = Math.round(((latest - prev)/prev)*100);
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
 * Cortex AI Analytics — runs a Snowflake Cortex COMPLETE query
 * Builds aggregates then asks Cortex to summarize.
 */
async function getCortexAnalyticsSummary() {
  const connOrPromise = getConnection();
  const conn = connOrPromise instanceof Promise ? await connOrPromise : connOrPromise;

  if (!conn) {
    return getMockCortexSummary();
  }

  // Real Snowflake Cortex path
  try {
    // First gather aggregates
    const byCause = await executeSql(conn,
      `SELECT cause_id, COUNT(*) as cnt, SUM(amount) as total, AVG(amount) as avg_amt FROM DONATIONS_ANALYTICS GROUP BY cause_id`);
    const total = await executeSql(conn, `SELECT COUNT(*) as c, SUM(amount) as s FROM DONATIONS_ANALYTICS`);
    const daily = await executeSql(conn,
      `SELECT TO_DATE(completed_at) as d, COUNT(*) as c, SUM(amount) as s FROM DONATIONS_ANALYTICS GROUP BY TO_DATE(completed_at) ORDER BY d DESC LIMIT 7`);
    const largest = await executeSql(conn, `SELECT cause_id, amount FROM DONATIONS_ANALYTICS ORDER BY amount DESC LIMIT 1`);

    const aggText = JSON.stringify({ byCause, total, daily, largest });
    const prompt = `You are an analytics assistant for a micro-donation platform. Given these aggregates: ${aggText}. Write a concise 2-3 sentence analytics summary highlighting: which cause is leading, average gift size, day-over-day trend, and largest gift. Keep it donor-friendly.`;

    // Escape single quotes for SQL
    const escaped = prompt.replace(/'/g, "''");
    const cortexSql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('llama3-8b', '${escaped}') as summary`;
    const rows = await executeSql(conn, cortexSql);
    const summary = rows && rows[0] ? (rows[0].SUMMARY || rows[0].summary || Object.values(rows[0])[0]) : 'No summary returned';
    return { mock: false, summary, aggregates: { byCause, total, daily, largest } };
  } catch (e) {
    console.error('[Snowflake Cortex] error', e.message);
    const mockFallback = getMockCortexSummary();
    return { mock: true, summary: `Cortex query failed (${e.message}). ` + (mockFallback.summary || ''), error: e.message, aggregates: mockFallback.aggregates };
  }
}

module.exports = {
  syncDonationToSnowflake,
  syncUnsyncedBatch,
  getCortexAnalyticsSummary,
  hashPhone,
  isConfigured,
  executeSql,
  getConnection
};
