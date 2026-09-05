/**
 * Google AI (Gemini) — donor transparency summary
 * Generates a plain-language impact paragraph from recent completed donations.
 */

let genAI = null;

function getClient() {
  const key = process.env.GOOGLE_AI_API_KEY;
  if (!key) return null;
  if (genAI) return genAI;
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    genAI = new GoogleGenerativeAI(key);
    return genAI;
  } catch (e) {
    console.error('[GoogleAI] init failed', e.message);
    return null;
  }
}

/**
 * Build a donor transparency summary via Gemini
 * @param {Array} recentDonations - last N completed donations (from SQLite)
 * @param {Array} raisedByCause - per-cause aggregates
 * @param {Object} stats - overall stats
 * @returns {Promise<{summary:string, mock:boolean}>}
 */
async function generateImpactSummary(recentDonations = [], raisedByCause = [], stats = {}) {
  const client = getClient();

  // Build a non-PII context string
  const totalRaised = stats.totalRaised || 0;
  const totalCount = stats.completed || 0;
  const causeLines = (raisedByCause || []).map(c => `- ${c.name}: KES ${c.raised.toLocaleString()} raised of KES ${c.target_amount.toLocaleString()} goal (${c.progress}%)`).join('\n');
  const recentLines = (recentDonations || []).slice(0, 10).map(d => `- KES ${d.amount} to ${d.cause_id} on ${d.completed_at || d.created_at}`).join('\n') || '- No recent donations yet';

  const prompt = `You are a warm, concise communications assistant for "Karibu Give", a Kenyan USSD micro-donation platform where anyone with a basic phone can give small amounts via mobile money.

Write a short, plain-language donor transparency summary (3-5 sentences, under 120 words) that a donor would see on a public dashboard. Be factual, optimistic, and specific. Do not invent numbers.

Context:
- Total raised: KES ${totalRaised.toLocaleString()} across ${totalCount} completed donations.
- Per-cause progress:
${causeLines}
- Recent gifts (last ${recentDonations.length}):
${recentLines}

Requirements:
- Mention the leading cause and overall progress.
- Use plain language — no jargon.
- End with a short thank-you.
- If no donations yet, warmly invite the first gift.`;

  if (!client) {
    // Mock fallback — heuristic summary without calling Gemini
    if (totalCount === 0) {
      return {
        mock: true,
        summary: `Karibu Give is just getting started — no completed donations yet. Your first gift of as little as KES 10 via USSD can help bring clean water, school books, and mobile health clinics to communities that need them most. Dial ${process.env.AT_USSD_CODE || '*384*1234#'} to give today. Asante sana — every shilling counts! (Mock summary — set GOOGLE_AI_API_KEY for Gemini-powered text)`
      };
    }
    const leading = [...(raisedByCause || [])].sort((a,b)=>b.raised-a.raised)[0];
    let s = `Together, ${totalCount} generous gift(s) totaling KES ${totalRaised.toLocaleString()} have been received. `;
    if (leading && leading.raised > 0) s += `${leading.name} leads with KES ${leading.raised.toLocaleString()} of its KES ${leading.target_amount.toLocaleString()} goal (${leading.progress}% complete). `;
    s += `Recent gifts show steady community support, with an average gift around KES ${Math.round(totalRaised/totalCount).toLocaleString()}. `;
    s += `Thank you for making generosity accessible — dial ${process.env.AT_USSD_CODE || '*384*1234#'} to add your gift.`;
    s += ' (Mock summary — set GOOGLE_AI_API_KEY for Gemini-powered text)';
    return { mock: true, summary: s };
  }

  try {
    const model = client.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    return { mock: false, summary: text };
  } catch (e) {
    console.error('[GoogleAI] generate failed', e.message);
    // Fallback to mock on failure
    return {
      mock: true,
      summary: `We have raised KES ${totalRaised.toLocaleString()} across ${totalCount} gifts so far — thank you! (Gemini call failed: ${e.message})`,
      error: e.message
    };
  }
}

module.exports = { generateImpactSummary };
