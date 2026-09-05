/**
 * Africa's Talking client wrapper.
 * Uses africastalking SDK when credentials are set; otherwise runs in mock mode
 * (logs and returns a fake checkoutRequestId) so the app works without real AT keys.
 */
let at = null;
let payment = null;

function getClient() {
  if (at) return { at, payment };
  const username = process.env.AT_USERNAME || 'sandbox';
  const apiKey = process.env.AT_API_KEY || '';
  // If no API key, stay in mock mode
  if (!apiKey) {
    console.warn('[AT] No AT_API_KEY set — running in MOCK mode (no real STK push)');
    return null;
  }
  try {
    at = require('africastalking')({ apiKey, username });
    payment = at.PAYMENT;
    console.log(`[AT] Initialized AT client as "${username}"`);
    return { at, payment };
  } catch (e) {
    console.error('[AT] Failed to init SDK', e.message);
    return null;
  }
}

/**
 * Initiate mobile money checkout (STK Push).
 * @param {string} phoneNumber - in international format e.g. +2547...
 * @param {number} amount - KES
 * @param {string} causeName - for productName / metadata
 * @returns {Promise<{checkoutRequestId:string, status:string, raw:any}>}
 */
async function initiateCheckout(phoneNumber, amount, causeName) {
  const client = getClient();
  if (!client || !client.payment) {
    // Mock checkout
    const fakeId = 'MOCK-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    console.log(`[AT MOCK] checkout ${fakeId} | phone=${phoneNumber} amount=${amount} cause=${causeName}`);
    return { checkoutRequestId: fakeId, status: 'Pending', raw: { mock: true } };
  }

  // AT Payment checkout — productName must be configured in AT dashboard
  const productName = process.env.AT_PRODUCT_NAME || 'KaribuGive';
  try {
    const result = await client.payment.checkout({
      phoneNumber,
      amount: amount.toString(),
      currencyCode: 'KES',
      productName,
      metadata: { cause: causeName }
    });
    // AT returns { status, description, transactionId, providerChannel ... } — use transactionId as checkout ref
    const checkoutRequestId = result.transactionId || result.checkoutRequestId || `AT-${Date.now()}`;
    console.log('[AT] checkout initiated', result);
    return { checkoutRequestId, status: result.status || 'Pending', raw: result };
  } catch (e) {
    console.error('[AT] checkout failed', e);
    // Fallback to mock so USSD flow still succeeds in sandbox/demo
    const fakeId = 'MOCK-ERR-' + Date.now();
    return { checkoutRequestId: fakeId, status: 'Pending', raw: { error: e.message, mockFallback: true } };
  }
}

module.exports = { getClient, initiateCheckout };
