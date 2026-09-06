# Karibu Give ❤ — USSD Micro-Donation Platform

> **DEV.to "generosity" weekend challenge** — anyone with a basic phone (no smartphone, no data) can donate small amounts via mobile money to causes, using Africa's Talking USSD + M-Pesa.

## Quick start

```bash
cp .env.example .env   # fill AT_API_KEY, GOOGLE_AI_API_KEY, Snowflake etc.
npm install
npm start              # http://localhost:3000
```

Admin: `http://localhost:3000/admin` (default `admin / karibu123` — set `ADMIN_USER/PASSWORD` in `.env`).

## Endpoints

| Route | Purpose |
|-------|---------|
| `GET /` | Landing page — total raised, causes + progress bars, dial code |
| `POST /ussd` | AT USSD callback — session state machine |
| `POST /payment-callback` | AT payment webhook — marks `pending→completed/failed`, syncs to Snowflake |
| `POST /payment-callback/simulate` | Dev helper to simulate a callback |
| `GET /admin` | Dashboard (HTTP Basic Auth) |
| `POST /admin/generate-impact` | Google Gemini donor transparency summary |
| `POST /admin/generate-cortex` | Snowflake Cortex analytics summary |
| `POST /admin/sync-snowflake` | Batch-sync unsynced rows |

## USSD flow

```
*384*6120# →
  1. Donate  2. Check total raised  0. Exit
  → pick cause (1..3) → enter amount (10-70000)
  → 1. Confirm  2. Cancel
  → pending row + STK push → "Check your phone"
```

Session state via in-memory `Map<sessionId, {step, causeIndex, amount}>` with 5-min TTL; cumulative `text` parsing is authoritative.

## Project structure

```
/src
  /routes  ussd.js  payment.js  admin.js  public.js
  /db      db.js  schema.sql  causes.js
  /services donations.js  atClient.js  googleAI.js  snowflake.js
  /views   index.ejs  admin.ejs  /partials  /public/css
server.js
```

## AI features (two distinct cards)

- **Google AI Impact Summary** (`src/services/googleAI.js:1`) — Gemini 1.5 Flash plain-language paragraph from recent completed donations. Distinct purple card + "Generate summary" button. Falls back to heuristic mock when `GOOGLE_AI_API_KEY` missing.
- **Snowflake Cortex Analytics** (`src/services/snowflake.js:1`) — `SNOWFLAKE.CORTEX.COMPLETE('llama3-8b', …)` over aggregates from `DONATIONS_ANALYTICS`. Blue card + "Refresh analytics" on demand. Falls back to SQLite aggregate heuristic in mock mode.

## Snowflake sync

- On `payment-callback` success → `syncDonationToSnowflake()` inserts hashed `phone_hash` (SHA256 truncated) into `DONATIONS_ANALYTICS`, marks `synced_to_snowflake=1`.
- `POST /admin/sync-snowflake` batch-syncs `synced_to_snowflake=false`.

## Mock modes

All external deps degrade gracefully: if `AT_API_KEY`, `GOOGLE_AI_API_KEY`, or Snowflake creds are absent, the app logs `MOCK` and continues — donations are still created, summaries still render via heuristic.

## Africa's Talking sandbox

Username `sandbox`, use `+254711082XXX` test numbers. Expose `/ussd` via ngrok for AT dashboard config.

## Data model

SQLite `donations` — `id, phone_number, cause_id, amount, status(pending|completed|failed), checkout_request_id, created_at, completed_at, synced_to_snowflake`. Causes are hardcoded in `causes.js`.

## License

MIT
