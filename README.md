# Sanchay — the counter that listens

A voice-first shopping counter built on Cloudflare Workers. Talk to Sanchay the way you'd talk to a shopkeeper: ask for something, get shown options, add things to your bag, ask what you paid last time, pay, and check out — all by voice, with a screen that follows along.

**Live:** [sanchay.store](https://sanchay.store)

## Track: AI Growth & Agentic Commerce

Sanchay targets **Conversational in-app checkout**, backed by the track's actual bar — *every money action explainable, bounded, and gated, with a visible audit trail and graceful failure handling* — rather than just a voice demo bolted onto a cart.

- **Explainable** — every gate that blocks an action (out of stock, over budget, not signed in) returns a real sentence, not a generic error. The agent is told to speak it, not paper over it.
- **Bounded** — a per-session spending cap the shopper sets by voice, a merchant-wide maximum order size independent of that cap, and live stock checks enforced atomically at the same moment an item is added or a checkout starts — not asynchronously, not best-effort.
- **Gated** — checkout requires a real, OTP-verified sign-in (not just a guest session id); the agent checks and reports sign-in status before attempting checkout rather than letting it fail as a surprise.
- **Audit trail** — every API call the app or the agent makes is logged and readable per-session (`GET /api/audit`), with an incremental cursor so a long conversation stays cheap to keep polling live. The on-screen Activity panel is this same log, not a separate summary.
- **Graceful failure** — stock vanishing mid-checkout, a payment gateway limit, a concurrent request winning a stock race, an expired session — each has a specific, tested, non-crashing path. See `evals/graceful-failure.eval.test.ts` and `evals/checkout-reconcile.eval.test.ts`.

Sanchay also ships an **agent-readable API surface** (`GET /api/tools`, `GET /openapi.yaml`) describing every commerce operation in an LLM tool-calling-compatible schema — a third-party agent, not just Sanchay's own voice agent, can discover and call the same checkout/cart/catalog endpoints directly over plain HTTP.

## What it does

- **Voice shopping** — powered by Gemini Live (browser-side WebSocket, 16kHz mic in / 24kHz speaker out), with tool calls for search, cart, checkout, and account lookups.
- **Vision** — ask the agent to describe or compare product images; it can look at multiple product photos in one call and answer questions about fit, color, or material.
- **Floating product-detail windows** — say "show me that" and a detail card opens with a bigger photo; ask for something similar and another opens beside it (up to 4 on desktop, one-at-a-time with arrows on mobile).
- **Live-updating bill** — the cart panel and activity log reflect what the agent just did in near-real-time, without polling continuously when nothing's happening (see [Performance](#performance-adaptive-polling) below).
- **Budget caps** — set a spoken budget for the session; every add/checkout is checked against it, and the agent is told the shortfall by name if it's exceeded.
- **Real payments** — Razorpay checkout (test mode), with webhook-verified payment confirmation, automatic stock release on failed/expired orders, and idempotent retries.
- **Purchase history & account profile** — a signed-in shopper can ask "what did I buy last time" or "how much have I spent" and get a real answer sourced from paid orders, not a guess.
- **Guest + signed-in sessions** — browsing and cart-building work anonymously; checkout requires OTP email sign-in, with guest cart/history migrated onto the account the moment they sign in.

## Architecture

```
Browser (React)                Cloudflare Worker                 External
────────────────                ─────────────────                 ────────
Gemini Live WS  ───────────────► generativelanguage.googleapis.com
   │ tool calls
   ▼
fetch() ───────────────────────► src/index.ts (router)
                                    ├─ api/cart.ts, checkout.ts, catalog.ts, ...
                                    ├─ D1 (sessions, cart, orders, audit log)
                                    ├─ Vectorize + Workers AI (semantic search)
                                    └─ Razorpay ──────────────────► razorpay.com
                                         ▲ webhook (signature-verified)
```

The voice connection (Gemini Live) is a direct browser↔Google WebSocket — the Worker is not in that path. When the model calls a tool (`add_to_cart`, `checkout`, etc.), the browser makes the exact same HTTP request a manual button click would make. The Worker has no idea whether a given request came from a voice tool call or a click; both get identical validation, identical stock/budget enforcement, and identical audit rows. This is why the on-screen cart/activity panel has to poll rather than being pushed to directly — see below.

## Performance: adaptive polling

The cart and activity panels refresh via polling (`/api/cart`, `/api/audit`) rather than a persistent push channel — Cloudflare Workers are stateless per-request, so real push would need a Durable Object per session, which is a legitimate future upgrade, not a requirement met by this submission.

To keep that polling cheap:
- Both polls only run while a voice call is actually connected/listening/speaking **and** the tab is visible — idle time (page open, no call, or backgrounded tab) polls nothing at all.
- `/api/audit` supports an incremental `?since=<timestamp>` cursor so a poll only fetches events newer than the last one already held, instead of re-fetching and re-parsing the same recent batch every 3 seconds.
- `/api/audit` is capped to the most recent 60 rows even without a cursor, and stale `api_call_log` rows are swept opportunistically — this was a real production incident (an uncapped audit query on a long-lived session exceeded the Worker's CPU time limit and took down concurrent requests on the same isolate) that's now covered by a regression test in `evals/audit-coverage.eval.test.ts`.

## Setup

Requirements: Node 20+, a Cloudflare account, a Razorpay test account, a Gemini API key.

```bash
npm install
npm install --prefix frontend
```

Create `.dev.vars` at the repo root (never committed — see `.gitignore`):

```
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
GEMINI_API_KEY=...
JWT_SIGNING_KEY=...          # any long random string in dev
ADMIN_TOKEN=...              # any string; gates /admin/* catalog-seeding routes
RESEND_API_KEY=...           # OTP sign-in emails; optional in dev — sign-in flow no-ops without it
TURNSTILE_SECRET_KEY=...     # optional; Turnstile verification is skipped if unset
```

Seed the catalog and run:

```bash
npm run dev              # Worker on localhost, serves the built frontend
npm run dev:frontend     # Vite dev server with hot reload (separate terminal)
curl -X POST localhost:8787/admin/seed-catalog -H "X-Admin-Token: <your ADMIN_TOKEN>"
```

Run tests:

```bash
npm test                 # 139 tests — real Worker + real D1 via @cloudflare/vitest-pool-workers
npx tsc --noEmit         # backend
npx tsc --noEmit --project frontend   # frontend
```

Deploy (requires `wrangler login` and secrets set via `wrangler secret put <NAME>` for each of the above):

```bash
npm run deploy
```

## Security posture

- Every D1 query is parameterized (`.bind()`) — no string-interpolated SQL anywhere.
- Razorpay webhook payloads are HMAC-verified before any event is trusted; a replayed genuine webhook is a no-op against already-settled order state, not a double-credit.
- Checkout and account-profile reads require a real bearer JWT whose `sub` matches the session's account — a session id alone (which guest browsing and cart-building use) is not sufficient to pay or read account data.
- Cart/session mutation endpoints are rate-limited per-session and per-IP at generous, non-realistic-usage-affecting thresholds — enough to stop a scripted flood, not felt by a real shopper or the voice agent acting on their behalf.
- Admin routes fail closed (503) if their gating token isn't configured, rather than silently allowing access.

## Tech stack

- **Backend:** Cloudflare Workers, D1 (SQLite), Vectorize (semantic catalog search), Workers AI (embeddings + image description)
- **Frontend:** React 19, Vite
- **Voice:** Gemini Live API (browser WebSocket)
- **Payments:** Razorpay (test mode)
- **Auth:** Email OTP + JWT, Cloudflare Turnstile (optional)
- **Testing:** Vitest + `@cloudflare/vitest-pool-workers` (tests run against a real Worker + real D1, not mocks)
