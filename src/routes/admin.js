const express = require('express');
const router = express.Router();
const { getAllDonations, getStats, getRaisedByCause, getRecentCompleted } = require('../services/donations');
const { generateImpactSummary } = require('../services/googleAI');
const { getCortexAnalyticsSummary, syncUnsyncedBatch } = require('../services/snowflake');
const { causes } = require('../db/causes');

// --- Basic HTTP Auth ---
function basicAuth(req, res, next) {
  const user = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASSWORD || 'password';
  // If no password set, allow through but warn (demo mode)
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('[Admin] ADMIN_PASSWORD not set — auth is permissive (set it for production)');
    // Still enforce if header present? For demo, allow without auth when no password set only if query bypass? Simpler: require auth always but use defaults
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Karibu Give Admin"');
    return res.status(401).send('Authentication required');
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const [u, p] = decoded.split(':');
  if (u === user && p === pass) return next();
  res.set('WWW-Authenticate', 'Basic realm="Karibu Give Admin"');
  return res.status(401).send('Invalid credentials');
}

router.use(basicAuth);

// GET /admin — dashboard
router.get('/', (req, res) => {
  const { status, cause_id } = req.query;
  const donations = getAllDonations({
    status: status || undefined,
    cause_id: cause_id || undefined
  });
  const stats = getStats();
  const raisedByCause = getRaisedByCause();
  // Mask phone: show *** *** 1234
  const masked = donations.map(d => ({
    ...d,
    phone_masked: maskPhone(d.phone_number)
  }));
  res.render('admin', {
    donations: masked,
    stats,
    raisedByCause,
    causes,
    filters: { status: status || '', cause_id: cause_id || '' },
    googleSummary: null,
    cortexSummary: null,
    query: req.query
  });
});

// POST /admin/generate-impact — Google AI summary
router.post('/generate-impact', async (req, res) => {
  try {
    const stats = getStats();
    const raisedByCause = getRaisedByCause();
    const recent = getRecentCompleted(20);
    const result = await generateImpactSummary(recent, raisedByCause, stats);
    res.json(result);
  } catch (e) {
    console.error('[Admin] generate-impact error', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/generate-cortex — Snowflake Cortex summary
router.post('/generate-cortex', async (req, res) => {
  try {
    const result = await getCortexAnalyticsSummary();
    res.json(result);
  } catch (e) {
    console.error('[Admin] generate-cortex error', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/sync-snowflake — batch sync unsynced
router.post('/sync-snowflake', async (req, res) => {
  try {
    const result = await syncUnsyncedBatch();
    res.json(result);
  } catch (e) {
    console.error('[Admin] sync-snowflake error', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/api/donations — JSON for debugging
router.get('/api/donations', (req, res) => {
  const donations = getAllDonations({
    status: req.query.status || undefined,
    cause_id: req.query.cause_id || undefined
  });
  res.json(donations);
});

function maskPhone(phone) {
  if (!phone) return '—';
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '*** ' + digits;
  return '*** *** ' + digits.slice(-4);
}

module.exports = router;
