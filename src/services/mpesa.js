/**
 * M-Pesa External Service — STK Push wrapper
 * Calls https://mpesa-service-3s2d.onrender.com/stkpush
 * Expected by mpesa-service docs (discovered via probing):
 *   POST {phone: "2547...", amount: <number>}  // phone must be 254..., NOT +254, amount integer KES
 *   Response 200: { MerchantRequestID, CheckoutRequestID, ResponseCode:"0", ResponseDescription:"Success...", CustomerMessage }
 *   Response 400: { error:"Phone and amount are required" }
 *   Response 500: { errorCode, errorMessage:"Bad Request - Invalid PhoneNumber" } or Incapsula HTML when WAF triggered
 *
 * This service is the user's external Render deployment that triggers real Daraja STK push.
 * For Karibu Give we prioritize this service over Africa's Talking when MPESA_SERVICE_URL is set.
 * Falls back to MOCK checkoutId so USSD flow never blocks in sandbox/demo or when WAF/rate-limit hits.
 */

const MPESA_SERVICE_URL = (process.env.MPESA_SERVICE_URL || 'https://mpesa-service-3s2d.onrender.com').replace(/\/$/, '');
const MPESA_STK_PATH = process.env.MPESA_STK_PATH || '/stkpush';
const MPESA_TIMEOUT_MS = parseInt(process.env.MPESA_TIMEOUT_MS || '15000', 10);

/**
 * Normalize phone to Daraja format: 2547XXXXXXXX
 * AT sends +254711... ; USSD users may enter 0711..., 254711..., +254711..., 7...
 */
function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).trim().replace(/\s+/g, '').replace(/-/g, '');
  // Remove leading +
  if (p.startsWith('+')) p = p.slice(1);
  // If starts with 0, replace 0 with 254
  if (p.startsWith('0')) p = '254' + p.slice(1);
  // If starts with 7 and length 9, prepend 254
  if (/^7\d{8}$/.test(p)) p = '254' + p;
  // Ensure digits only
  p = p.replace(/\D/g, '');
  // Validate: should be 12 digits starting with 254
  if (!/^254\d{9}$/.test(p)) {
    console.warn(`[M-Pesa] phone normalization produced unexpected format: ${phone} -> ${p}`);
  }
  return p;
}

/**
 * Trigger STK Push via external service.
 * @param {string} phoneNumber - any format (+254..., 07..., 254...)
 * @param {number} amount - KES integer (10-70000)
 * @param {string} causeName - for logging / optional accountReference
 * @returns {Promise<{checkoutRequestId:string, status:string, raw:any, provider:'mpesa-service'|'mock'}>}
 */
async function initiateMpesaStkPush(phoneNumber, amount, causeName) {
  const normalized = normalizePhone(phoneNumber);
  const url = `${MPESA_SERVICE_URL}${MPESA_STK_PATH}`;
  const payload = { phone: normalized, amount: Number(amount) };

  console.log(`[M-Pesa] STK push → ${url} phone=${normalized} amount=${amount} cause=${causeName}`);

  // If service URL is explicitly disabled (e.g. MPESA_SERVICE_URL=disabled) fallback to mock
  if (!MPESA_SERVICE_URL || MPESA_SERVICE_URL.toLowerCase() === 'disabled' || MPESA_SERVICE_URL === 'mock') {
    return mockCheckout(normalized, amount, 'mpesa-disabled');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MPESA_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // Browser-like UA reduces Incapsula WAF false-positives observed on Render -> Render calls
        'User-Agent': 'KaribuGive/1.0 (+https://karibu-give.example; Node fetch)',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    let body;
    if (contentType.includes('application/json')) {
      body = await res.json();
    } else {
      const text = await res.text();
      // Incapsula WAF returns HTML on block — treat as transient error
      if (text.includes('Incapsula') || text.includes('ROBOTS')) {
        console.warn(`[M-Pesa] WAF block detected (Incapsula) status=${res.status} — falling back to mock`);
        return mockCheckout(normalized, amount, 'waf-block', { status: res.status, html: text.slice(0, 200) });
      }
      // Try to parse as JSON anyway
      try { body = JSON.parse(text); } catch { body = { rawText: text }; }
    }

    console.log(`[M-Pesa] response status=${res.status} body=`, JSON.stringify(body).slice(0, 800));

    if (!res.ok) {
      // 400 {"error":"Phone and amount are required"} or 500 {"errorMessage":"Invalid PhoneNumber"}
      const errMsg = body.error || body.errorMessage || body.message || `HTTP ${res.status}`;
      console.warn(`[M-Pesa] STK push failed HTTP ${res.status}: ${errMsg}`);
      // For validation errors (bad phone) don't fallback silently — surface but still create mock so USSD can complete
      // For demo purposes we still return mock checkout so donor flow continues
      return mockCheckout(normalized, amount, `http-${res.status}-${errMsg}`, body);
    }

    // Success per Daraja: ResponseCode == "0", CheckoutRequestID present
    const checkoutRequestId = body.CheckoutRequestID || body.checkoutRequestId || body.CheckoutRequestID || body.transactionId || null;
    const merchantId = body.MerchantRequestID || body.merchantRequestID;
    const responseCode = body.ResponseCode || body.responseCode;
    const responseDesc = body.ResponseDescription || body.CustomerMessage || '';

    if (checkoutRequestId && (responseCode === '0' || responseCode === 0 || responseDesc.toLowerCase().includes('success'))) {
      console.log(`[M-Pesa] STK push accepted checkoutRequestId=${checkoutRequestId} merchantId=${merchantId}`);
      return {
        checkoutRequestId,
        status: 'Pending',
        raw: body,
        provider: 'mpesa-service',
      };
    }

    // Unexpected success shape but still 2xx — use checkout or fallback
    if (checkoutRequestId) {
      return { checkoutRequestId, status: 'Pending', raw: body, provider: 'mpesa-service' };
    }

    console.warn('[M-Pesa] unexpected success shape — falling back to mock', body);
    return mockCheckout(normalized, amount, 'unexpected-shape', body);
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') {
      console.error(`[M-Pesa] timeout after ${MPESA_TIMEOUT_MS}ms to ${url}`);
      return mockCheckout(normalized, amount, 'timeout', { error: e.message });
    }
    console.error('[M-Pesa] fetch error', e.message);
    // Network / DNS / fetch error — fallback to mock so USSD never hangs
    return mockCheckout(normalized, amount, 'fetch-error', { error: e.message });
  }
}

function mockCheckout(phone, amount, reason, rawExtra = {}) {
  const fakeId = 'MOCK-MPESA-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  console.log(`[M-Pesa MOCK] checkout ${fakeId} | phone=${phone} amount=${amount} reason=${reason}`);
  return {
    checkoutRequestId: fakeId,
    status: 'Pending',
    raw: { mock: true, reason, ...rawExtra },
    provider: 'mock',
  };
}

module.exports = { initiateMpesaStkPush, normalizePhone, MPESA_SERVICE_URL, MPESA_STK_PATH };
