# PRINTOS — Testing Suite & Acceptance Guide

---

## 1. Test Suite Architecture

PRINTOS includes a comprehensive unit, integration, and acceptance test suite written in **Vitest**:

| Test Suite | Purpose | Tests | Status |
| :--- | :--- | :---: | :---: |
| `tests/pricing.test.ts` | Deterministic paisa calculations, paper sizes, color modes, duplex, copies, and discounts | 10 | PASS |
| `tests/page-range.test.ts` | Complex range parsing, whitespace handling, deduplication, sorting, bounds & error validation | 11 | PASS |
| `tests/order-state-machine.test.ts` | Valid status progression, terminal state checks, and illegal jump rejection | 5 | PASS |
| `tests/queue-idempotency.test.ts` | Payment idempotency, duplicate webhook delivery protection, and atomic concurrent claiming | 6 | PASS |
| `tests/document-inspector.test.ts` | PDF/image dimension extraction, page counting, and file size/type rejection | 5 | PASS |
| `tests/mock-agent-failure.test.ts` | Mock agent simulated failure, retry scheduling, and maximum attempt limits | 1 | PASS |
| `tests/production-fail-fast.test.ts` | Environment sanity checks ensuring production cannot run with in-memory fallbacks | 2 | PASS |
| `tests/openwa-provider.test.ts` | OpenWA webhook verification, message sending, session check, and SSRF guard | 16 | PASS |
| `tests/whatsapp-inbox.test.ts` | Inbound webhook pipeline, HMAC validation, and `whatsapp_inbox` persistence | 4 | PASS |
| `tests/whatsapp-state-machine.test.ts` | Multi-step conversational transitions (`IDLE` ➔ `AWAITING_DOCUMENT` ➔ `AWAITING_CONFIG`) | 6 | PASS |
| `tests/whatsapp-worker-recovery.test.ts` | Outbox worker retry backoff, dead-lettering, and worker recovery | 6 | PASS |
| `tests/supabase-whatsapp-integration.test.ts` | Repository layer integration for WhatsApp entities with database schema | 1 | PASS |
| `tests/payment-provider.test.ts` | Razorpay signature verification, NPCI UPI intent generation, and mock provider | 8 | PASS |
| `tests/payment-webhook.test.ts` | Idempotent payment webhook, amount validation, and job creation | 5 | PASS |
| `tests/windows-print-agent.test.ts` | SumatraPDF settings formatting, hardware discovery, and agent spooling | 5 | PASS |
| `tests/cleanup-service.test.ts` | Document retention policy, expired file purge, and cron authentication | 2 | PASS |
| `tests/env-validator.test.ts` | Fail-fast production environment validation and credential checks | 4 | PASS |
| `tests/rate-limiter.test.ts` | Sliding window rate limiting and webhook abuse protection | 3 | PASS |
| `tests/supabase-integration.test.ts` | Real Supabase database persistence and queue RPC checks | 1 | PASS |
| `tests/admin-auth.test.ts` | Web Crypto HMAC token signing, tamper rejection, credentials & route guards | 10 | PASS |
| **Total Automated Tests** | | **111** | **100% PASS** |

---

## 2. Running Automated Tests

Run the full Vitest test suite:
```powershell
npm test
```

Expected Output:
```
 Test Files  20 passed (20)
      Tests  111 passed (111)
```

To run tests in watch mode during development:
```powershell
npm run test:watch
```

---

## 3. Master Acceptance Tests

### Phase 1 Master Acceptance Test
Executes the end-to-end core printing pipeline (order creation, paisa pricing, payment transition, atomic concurrency claim, mock printing, audit trail):
```powershell
npm run acceptance:phase1
```

#### Steps Verified:
1. **Input Validation**: Rejects invalid page ranges ("5-1"), zero copies, and illegal state transitions (`RECEIVED` ➔ `PRINTING`).
2. **Order Creation & Pricing**: Creates order #P1042 (A4 / B&W / Duplex / 2 copies / 12 pages) = ₹48.00 (4800 paisa).
3. **Verified Payment**: Webhook marks order `PAID` and transitions it to `QUEUED`.
4. **Idempotency**: Repeated webhooks for the same order and transaction do NOT create duplicate print jobs.
5. **Atomic Claim**: Two concurrent agents attempt to claim the job simultaneously; exactly one agent claims it, and the other receives null.
6. **Agent Execution**: Mock Print Agent moves order to `PRINTING`, simulates spooling, and marks `COMPLETED`.
7. **Audit Trail & Metrics**: Verifies 8 recorded audit events and updated dashboard revenue & page totals.

---

### Phase 2 WhatsApp Ingestion Acceptance Test
Executes the conversational WhatsApp intake, document processing, and outbox delivery pipeline:
```powershell
npm run acceptance:phase2
```

#### Steps Verified:
1. **HMAC Webhook Ingestion**: OpenWA signature verified and stored in `whatsapp_inbox`.
2. **Conversational Transition**: User prompt triggers state progression `IDLE` ➔ `AWAITING_DOCUMENT`.
3. **Document Ingestion & Analysis**: Document upload triggers PDF analysis, extracting page count and dimensions.
4. **Interactive Configuration**: Configuration parser processes color, duplex, and page range selections.
5. **Fulfillability Policy**: Verifies that shop has active `ONLINE` printers matching requested capabilities.
6. **Outbox Worker Queue**: Messages generated, queued in `whatsapp_outbox`, processed with exponential backoff, and dispatched.
