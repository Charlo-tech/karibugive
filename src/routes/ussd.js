const express = require('express');
const router = express.Router();
const { causes, getCauseByIndex } = require('../db/causes');
const { createDonation, getStats } = require('../services/donations');
const { initiateCheckout } = require('../services/atClient');

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
 * POST /ussd — Africa's Talking USSD callback
 * Body: sessionId, serviceCode, phoneNumber, text
 * text is the full USSD input concatenated with "*" e.g. "1*2*100*1"
 */
router.post('/', async (req, res) => {
  const { sessionId, serviceCode, phoneNumber, text } = req.body;
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
          // Show causes
          let menu = 'Choose a cause:\n';
          causes.forEach((c, i) => {
            menu += `${i + 1}. ${c.name}\n`;
          });
          menu += '0. Back';
          response = ussdResponse(menu, false);
          setSession(sessionId, { step: 'choose_cause' });
        } else if (parts.length === 2) {
          const choice = parts[1];
          if (choice === '0') {
            response = ussdResponse(
              `Welcome to Karibu Give \u2764\uFE0F\n1. Donate\n2. Check total raised\n0. Exit`,
              false
            );
          } else {
            const cause = getCauseByIndex(parseInt(choice, 10));
            if (!cause) {
              response = ussdResponse('Invalid cause. Try again.\n0. Back', false);
            } else {
              setSession(sessionId, { step: 'enter_amount', causeIndex: parseInt(choice, 10) });
              response = ussdResponse(`You chose: ${cause.name}\nEnter amount (KES 10 - 70000):`, false);
            }
          }
        } else if (parts.length === 3) {
          const causeIdx = parseInt(parts[1], 10);
          const cause = getCauseByIndex(causeIdx);
          const amountStr = parts[2];
          if (amountStr === '0') {
            // back to cause list
            let menu = 'Choose a cause:\n';
            causes.forEach((c, i) => { menu += `${i + 1}. ${c.name}\n`; });
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
          const cause = getCauseByIndex(causeIdx);
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
              // Create pending donation + trigger STK push
              // Normalize phone: AT sends +254... already
              const normalizedPhone = (phoneNumber || '').trim();
              let checkoutId = null;
              try {
                const result = await initiateCheckout(normalizedPhone, amount, cause.name);
                checkoutId = result.checkoutRequestId;
              } catch (e) {
                console.error('[USSD] checkout error', e);
                checkoutId = 'ERR-' + Date.now();
              }
              try {
                const donation = createDonation({
                  phone_number: normalizedPhone,
                  cause_id: cause.id,
                  amount,
                  checkout_request_id: checkoutId
                });
                console.log(`[USSD] donation #${donation.id} pending checkout=${checkoutId}`);
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
});

module.exports = router;
