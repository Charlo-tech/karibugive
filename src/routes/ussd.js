const express = require('express');
const router = express.Router();
const causesMod = require('../db/causes');
const { createDonation, getStats } = require('../services/donations');
const { initiateCheckout } = require('../services/atClient');
const { initiateMpesaStkPush } = require('../services/mpesa');

// Simple in-memory session store: sessionId -> { step, causeIndex, amount }
const sessions = new Map();

// USSD session timeout: 2 min — periodic cleanup
setInterval(() => {
  // naive: keep map unbounded for weekend scale is fine; cleanup entries older than 10m
  // Since we don't store timestamp, we keep all; GC via setTimeout per session instead
}, 60_000);

function setSession(sessionId, data) {
  sessions.set(sessionId, data);
  // auto-expire after 5 min
  setTimeout(() => sessions.delete(sessionId), 5 * 60 * 1000);
}

function ussdResponse(text, isEnd) {
  const prefix = isEnd ? 'END' : 'CON';
  return `${prefix} ${text}`;
}

/**
 * Shared USSD handler for both GET (browser testing) and POST (AT callback)
 * AT sends POST with form-encoded body, but we also support GET query for manual browser tests
 * so that visiting /ussd?sessionId=TEST&phoneNumber=+254...&text=1 works instead of 404.
 */
async function handleUssd(req, res) {
  // Support both POST body and GET query — AT uses POST, browser tests may use GET query
  const src = req.method === 'GET' ? req.query : req.body;
  const { sessionId, serviceCode, phoneNumber, text } = src || {};

  // If GET with no USSD params, show a friendly help page instead of 404
  if (req.method === 'GET' && !sessionId && !phoneNumber && !text) {
    return res.type('text/plain').send(
      'Karibu Give USSD endpoint is alive.\n' +
      'AT uses POST — but GET also works for browser testing.\n' +
      'Examples:\n' +
      '  GET  /ussd?sessionId=TEST123&phoneNumber=%2B254711082000&text=\n' +
      '  POST /ussd  body: sessionId=TEST123&phoneNumber=%2B254711082000&text=1\n' +
      'Flow: "" -> "1" -> "1*1" -> "1*1*100" -> "1*1*100*1"\n' +
      'See README for AT dashboard setup.'
    );
  }
  console.log(`[USSD] session=${sessionId} phone=${phoneNumber} text="${text}"`);

  // Normalize text — AT sends "" on first request
  const rawText = (text || '').trim();
  // Support both AT's cumulative `text` and incremental handling via session store
  // We use cumulative parsing as authoritative; session store is supplemental

  let response = '';

  try {
    if (rawText === '') {
      // Step 1: Welcome menu
      setSession(sessionId, { step: 'welcome' });
      response = ussdResponse(
        `Welcome to Karibu Give \u2764\uFE0F\nGive small, give often.\n1. Donate\n2. Check total raised\n0. Exit`,
        false
      );
    } else {
      const parts = rawText.split('*');
      const first = parts[0];

      if (first === '0') {
        sessions.delete(sessionId);
        response = ussdResponse('Asante! Thank you for visiting Karibu Give. Goodbye.', true);
      } else if (first === '2') {
        // Check total raised
        if (parts.length === 1) {
          const stats = getStats();
          const raised = stats.totalRaised;
          response = ussdResponse(
            `Total raised so far: KES ${raised.toLocaleString()}\nAcross ${stats.completed} completed donation(s).\n\n0. Back`,
            false
          );
          // store step for back handling
          setSession(sessionId, { step: 'total_raised' });
        } else if (parts[1] === '0') {
          response = ussdResponse(
            `Welcome to Karibu Give \u2764\uFE0F\n1. Donate\n2. Check total raised\n0. Exit`,
            false
          );
        } else {
          response = ussdResponse('Invalid choice.\n0. Back', false);
        }
      } else if (first === '1') {
        // Donate flow
        if (parts.length === 1) {
          // Show active causes only (max 3) — admin controls which are active
          const activeCauses = causesMod.getActiveCauses();
          if (activeCauses.length === 0) {
            response = ussdResponse('No active causes at the moment. Please try again later.\n0. Back', false);
            setSession(sessionId, { step: 'choose_cause' });
          } else {
            let menu = 'Choose a cause:\n';
            activeCauses.forEach((c, i) => {
              menu += `${i + 1}. ${c.name}\n`;
            });
            menu += '0. Back';
            response = ussdResponse(menu, false);
            setSession(sessionId, { step: 'choose_cause' });
          }
        } else if (parts.length === 2) {
          const choice = parts[1];
          if (choice === '0') {
            response = ussdResponse(
              `Welcome to Karibu Give \u2764\uFE0F\n1. Donate\n2. Check total raised\n0. Exit`,
              false
            );
          } else {
            const cause = causesMod.getCauseByIndex(parseInt(choice, 10));
            if (!cause) {
              response = ussdResponse('Invalid cause. Try again.\n0. Back', false);
            } else {
              setSession(sessionId, { step: 'enter_amount', causeIndex: parseInt(choice, 10) });
              response = ussdResponse(`You chose: ${cause.name}\nEnter amount (KES 10 - 70000):`, false);
            }
          }
        } else if (parts.length === 3) {
          const causeIdx = parseInt(parts[1], 10);
          const cause = causesMod.getCauseByIndex(causeIdx);
          const amountStr = parts[2];
          if (amountStr === '0') {
            // back to cause list
            let menu = 'Choose a cause:\n';
            causesMod.getActiveCauses().forEach((c, i) => { menu += `${i + 1}. ${c.name}\n`; });
            menu += '0. Back';
            response = ussdResponse(menu, false);
          } else {
            const amount = parseInt(amountStr, 10);
            if (!cause) {
              response = ussdResponse('Invalid cause. Dial again.', true);
            } else if (isNaN(amount) || amount < 10 || amount > 70000) {
              response = ussdResponse('Invalid amount. Enter KES 10 - 70000.\n0. Cancel', false);
            } else {
              setSession(sessionId, { step: 'confirm', causeIndex: causeIdx, amount });
              response = ussdResponse(
                `Donate KES ${amount} to ${cause.name}?\n1. Confirm\n2. Cancel`,
                false
              );
            }
          }
        } else if (parts.length === 4) {
          const causeIdx = parseInt(parts[1], 10);
          const cause = causesMod.getCauseByIndex(causeIdx);
          const amount = parseInt(parts[2], 10);
          const confirm = parts[3];
          if (confirm === '2' || confirm === '0') {
            sessions.delete(sessionId);
            response = ussdResponse('Donation cancelled. Asante!\nDial again to give.', true);
          } else if (confirm === '1') {
            if (!cause || isNaN(amount) || amount < 10) {
              response = ussdResponse('Invalid details. Please dial again.', true);
              sessions.delete(sessionId);
            } else {
              // Create pending donation + trigger STK push via external M-Pesa service (Render) then fallback to AT
              // AT sends +254..., Daraja expects 254..., mpesa.js normalizes for us
              const normalizedPhone = (phoneNumber || '').trim();
              let checkoutId = null;
              let checkoutProvider = 'mpesa-service';
              try {
                // Priority: external M-Pesa service (https://mpesa-service-3s2d.onrender.com/stkpush)
                // Set MPESA_SERVICE_URL to "disabled" or "mock" to skip and use AT mock only
                const mpesaResult = await initiateMpesaStkPush(normalizedPhone, amount, cause.name);
                checkoutId = mpesaResult.checkoutRequestId;
                checkoutProvider = mpesaResult.provider;
                console.log(`[USSD] M-Pesa STK result provider=${mpesaResult.provider} checkoutId=${checkoutId}`);

                // If mpesa fell back to mock and AT is configured, try AT as second chance for a real checkout
                if (mpesaResult.provider === 'mock' && process.env.AT_API_KEY) {
                  try {
                    console.log('[USSD] mpesa was mock — trying AT checkout as fallback');
                    const atResult = await initiateCheckout(normalizedPhone, amount, cause.name);
                    // Prefer AT's real id if it looks non-mock (not starting with MOCK)
                    if (atResult && atResult.checkoutRequestId && !atResult.checkoutRequestId.startsWith('MOCK')) {
                      checkoutId = atResult.checkoutRequestId;
                      checkoutProvider = 'africastalking';
                    } else if (atResult && atResult.raw && !atResult.raw.mock) {
                      checkoutId = atResult.checkoutRequestId;
                      checkoutProvider = 'africastalking';
                    }
                  } catch (atErr) {
                    console.warn('[USSD] AT fallback failed', atErr.message);
                  }
                }
              } catch (e) {
                console.error('[USSD] mpesa checkout error', e);
                // Final fallback to AT before giving up to ERR
                try {
                  const atFallback = await initiateCheckout(normalizedPhone, amount, cause.name);
                  checkoutId = atFallback.checkoutRequestId;
                  checkoutProvider = 'africastalking-fallback';
                } catch (atErr2) {
                  console.error('[USSD] AT fallback also failed', atErr2);
                  checkoutId = 'ERR-' + Date.now();
                }
              }
              try {
                const donation = createDonation({
                  phone_number: normalizedPhone,
                  cause_id: cause.id,
                  amount,
                  checkout_request_id: checkoutId
                });
                console.log(`[USSD] donation #${donation.id} pending checkout=${checkoutId} via ${checkoutProvider}`);
              } catch (e) {
                console.error('[USSD] DB insert failed', e);
              }
              sessions.delete(sessionId);
              response = ussdResponse(
                `Thank you! Check your phone to complete payment of KES ${amount} to ${cause.name}.\nYou will receive an M-Pesa prompt shortly.`,
                true
              );
            }
          } else {
            response = ussdResponse('Invalid choice.\n1. Confirm\n2. Cancel', false);
          }
        } else {
          response = ussdResponse('Invalid input. Please dial again.', true);
          sessions.delete(sessionId);
        }
      } else {
        response = ussdResponse('Invalid choice.\n1. Donate\n2. Check total raised\n0. Exit', false);
      }
    }
  } catch (err) {
    console.error('[USSD] handler error', err);
    response = ussdResponse('Oops, something went wrong. Please try again later.', true);
  }

  res.set('Content-Type', 'text/plain');
  res.send(response);
}

router.get('/', handleUssd);
router.post('/', handleUssd);

module.exports = router;
