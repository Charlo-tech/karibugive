const express = require('express');
const router = express.Router();
const { getDonationByCheckoutId, updateDonationStatus } = require('../services/donations');
const { syncDonationToSnowflake } = require('../services/snowflake');

async function handlePaymentCallback(req, res) {
  console.log('[PAYMENT CALLBACK] method=' + req.method + ' body:', JSON.stringify(req.body));
  console.log('[PAYMENT CALLBACK] query:', JSON.stringify(req.query));

  // AT sometimes sends as URL-encoded form, sometimes JSON, sometimes GET query — handle all
  const body = req.body || {};
  const data = { ...req.query, ...body };

  // If GET with no checkout id, show help instead of 404 (allows browser to open endpoint)
  const hasCheckoutKey = !!(data.checkoutRequestId || data.checkoutRequestID || data.transactionId || data.transId || data.requestId || data.checkout_request_id || data.id);
  if (req.method === 'GET' && !hasCheckoutKey) {
    return res.type('text/plain').send(
      'Karibu Give payment callback is alive.\n' +
      'AT will POST here with JSON or form: { checkoutRequestId, status }\n' +
      'Examples:\n' +
      '  GET  /payment-callback?checkoutRequestId=MOCK-...&status=Success\n' +
      '  POST /payment-callback -H "Content-Type: application/json" -d \'{"checkoutRequestId":"MOCK-...","status":"Success"}\'\n'
    );
  }

  // Try multiple key names for checkout id
  const checkoutId =
    data.checkoutRequestId ||
    data.checkoutRequestID ||
    data.transactionId ||
    data.transId ||
    data.requestId ||
    data.checkout_request_id ||
    data.id ||
    null;

  // Status can be "Success", "Failed", "Completed", etc.
  const rawStatus = (data.status || data.transactionStatus || data.state || '').toString().toLowerCase();
  const isSuccess = ['success', 'completed', 'successful', 'paid'].includes(rawStatus);
  const isFailed = ['failed', 'failure', 'cancelled', 'canceled'].includes(rawStatus);

  // AT sandbox sometimes sends statusCode 0 for success — handle that
  const statusCode = data.statusCode !== undefined ? String(data.statusCode) : null;
  const resolvedSuccess = isSuccess || statusCode === '0' || (!isFailed && rawStatus === '' && checkoutId);

  // If we can't find checkoutId, try to match by phone+amount fallback (for manual test)
  if (!checkoutId) {
    console.warn('[PAYMENT CALLBACK] no checkoutRequestId found, payload:', data);
    // Still respond 200 quickly as AT expects
    return res.status(200).json({ status: 'ignored', reason: 'no checkoutRequestId' });
  }

  try {
    const donation = getDonationByCheckoutId(checkoutId);
    if (!donation) {
      console.warn(`[PAYMENT CALLBACK] no donation found for checkoutId=${checkoutId}`);
      // For mock IDs, we still want to acknowledge
      return res.status(200).json({ status: 'not_found', checkoutRequestId: checkoutId });
    }

    if (donation.status === 'completed') {
      // idempotent
      return res.status(200).json({ status: 'already_completed', id: donation.id });
    }

    if (resolvedSuccess || isSuccess) {
      const updated = updateDonationStatus(donation.id, 'completed');
      console.log(`[PAYMENT CALLBACK] donation #${donation.id} marked completed`);
      // Trigger Snowflake sync (fire-and-forget but log)
      try {
        const syncResult = await syncDonationToSnowflake(updated);
        if (syncResult && syncResult.mock !== true && syncResult.success !== false) {
          // mark synced if real insert succeeded
          // syncDonationToSnowflake handles marking internally; also do here for safety if needed
        }
      } catch (e) {
        console.error('[PAYMENT CALLBACK] snowflake sync error (will retry via batch)', e.message);
      }
      return res.status(200).json({ status: 'completed', id: donation.id });
    } else if (isFailed) {
      updateDonationStatus(donation.id, 'failed');
      console.log(`[PAYMENT CALLBACK] donation #${donation.id} marked failed`);
      return res.status(200).json({ status: 'failed', id: donation.id });
    } else {
      // Unknown status — log but don't change
      console.warn(`[PAYMENT CALLBACK] unknown status "${rawStatus}" for ${checkoutId}`);
      return res.status(200).json({ status: 'unknown', rawStatus, id: donation.id });
    }
  } catch (err) {
    console.error('[PAYMENT CALLBACK] error', err);
    // Always respond 200 to prevent AT retry storm
    return res.status(200).json({ status: 'error', message: err.message });
  }
}

router.get('/', handlePaymentCallback);
router.post('/', handlePaymentCallback);

// Debug helper: simulate callback for local testing (not in production)
router.post('/simulate', async (req, res) => {
  const { checkoutRequestId, status } = req.body;
  if (!checkoutRequestId) return res.status(400).json({ error: 'checkoutRequestId required' });
  const fakeStatus = status || 'Success';
  // Forward to main handler logic via internal call — just do update directly
  const donation = getDonationByCheckoutId(checkoutRequestId);
  if (!donation) return res.status(404).json({ error: 'donation not found' });
  if (fakeStatus.toLowerCase().includes('success') || fakeStatus.toLowerCase().includes('complet')) {
    const updated = updateDonationStatus(donation.id, 'completed');
    try { await syncDonationToSnowflake(updated); } catch (_) {}
    return res.json({ status: 'completed', donation: updated });
  } else {
    const updated = updateDonationStatus(donation.id, 'failed');
    return res.json({ status: 'failed', donation: updated });
  }
});

module.exports = router;
