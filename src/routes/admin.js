const express = require('express');
const router = express.Router();
const { getAllDonations, getStats, getRaisedByCause, getRecentCompleted } = require('../services/donations');
const { generateImpactSummary } = require('../services/googleAI');
const { getCortexAnalyticsSummary, syncUnsyncedBatch } = require('../services/snowflake');
const causesMod = require('../db/causes');

// --- Basic HTTP Auth ---
function basicAuth(req, res, next) {
  const user = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASSWORD || 'password';
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('[Admin] ADMIN_PASSWORD not set — auth is permissive (set it for production)');
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
  const raisedByCause = getRaisedByCause({ activeOnly: false });
  const allCauses = causesMod.getAllCauses();
  const activeCauses = causesMod.getActiveCauses();
  const masked = donations.map(d => ({
    ...d,
    phone_masked: maskPhone(d.phone_number)
  }));
  res.render('admin', {
    donations: masked,
    stats,
    raisedByCause,
    causes: allCauses, // for filters and management
    activeCauses,
    allCauses,
    filters: { status: status || '', cause_id: cause_id || '' },
    googleSummary: null,
    cortexSummary: null,
    query: req.query,
    maxActive: causesMod.MAX_ACTIVE,
    flash: req.query.flash || null,
    error: req.query.error || null,
  });
});

// --- Cause management ---

// POST /admin/causes — create new cause
router.post('/causes', (req, res) => {
  const { name, description, target_amount, emoji, is_active } = req.body;
  try {
    const wantsActive = is_active === 'on' || is_active === '1' || is_active === true;
    const cause = causesMod.createCause({
      name,
      description,
      target_amount,
      emoji,
      is_active: wantsActive,
    });
    return res.redirect('/admin?flash=' + encodeURIComponent(`Cause "${cause.name}" created${wantsActive ? ' and activated' : ''}.`));
  } catch (e) {
    return res.redirect('/admin?error=' + encodeURIComponent(e.message));
  }
});

// POST /admin/causes/:id/toggle — activate/deactivate
router.post('/causes/:id/toggle', (req, res) => {
  const { id } = req.params;
  try {
    const existing = causesMod.getCauseById(id);
    if (!existing) throw new Error('Cause not found');
    const nextActive = existing.is_active ? 0 : 1;
    causesMod.setActive(id, nextActive);
    const msg = nextActive ? `Activated "${existing.name}".` : `Deactivated "${existing.name}".`;
    return res.redirect('/admin?flash=' + encodeURIComponent(msg));
  } catch (e) {
    return res.redirect('/admin?error=' + encodeURIComponent(e.message));
  }
});

// POST /admin/causes/:id/delete — delete (only if no donations)
router.post('/causes/:id/delete', (req, res) => {
  const { id } = req.params;
  try {
    const c = causesMod.getCauseById(id);
    causesMod.deleteCause(id);
    return res.redirect('/admin?flash=' + encodeURIComponent(`Deleted "${c ? c.name : id}".`));
  } catch (e) {
    return res.redirect('/admin?error=' + encodeURIComponent(e.message));
  }
});

// POST /admin/causes/:id/edit — update name/description/target/emoji (not active)
router.post('/causes/:id/edit', (req, res) => {
  const { id } = req.params;
  const { name, description, target_amount, emoji } = req.body;
  try {
    const updated = causesMod.updateCause(id, { name, description, target_amount, emoji });
    return res.redirect('/admin?flash=' + encodeURIComponent(`Updated "${updated.name}".`));
  } catch (e) {
    return res.redirect('/admin?error=' + encodeURIComponent(e.message));
  }
});

// --- AI & sync ---

// POST /admin/generate-impact — Google AI summary
router.post('/generate-impact', async (req, res) => {
  try {
    const stats = getStats();
    const raisedByCause = getRaisedByCause({ activeOnly: false });
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

// GET /admin/api/causes — JSON for debugging
router.get('/api/causes', (req, res) => {
  res.json({
    all: causesMod.getAllCauses(),
    active: causesMod.getActiveCauses(),
    maxActive: causesMod.MAX_ACTIVE,
    countActive: causesMod.countActive(),
  });
});

function maskPhone(phone) {
  if (!phone) return '—';
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '*** ' + digits;
  return '*** *** ' + digits.slice(-4);
}

module.exports = router;
