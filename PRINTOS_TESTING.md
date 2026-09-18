# PRINTOS — Testing Suite & Acceptance Guide

---

## 1. Test Suite Architecture

PRINTOS includes comprehensive unit and integration tests written in **Vitest**:

| Test Suite | Purpose | Tests | Status |
| :--- | :--- | :---: | :---: |
| `tests/pricing.test.ts` | Deterministic paisa calculations, paper sizes, color modes, duplex, copies, and discounts | 10 | PASS |
| `tests/page-range.test.ts` | Complex range parsing, whitespace handling, deduplication, sorting, bounds & error validation | 11 | PASS |
| `tests/order-state-machine.test.ts` | Valid status progression, terminal state checks, and illegal jump rejection | 5 | PASS |
| `tests/queue-idempotency.test.ts` | Payment idempotency, duplicate webhook delivery protection, and atomic concurrent claiming | 5 | PASS |
| `tests/document-inspector.test.ts` | PDF/image dimension extraction, page counting, and file size/type rejection | 5 | PASS |
| `tests/mock-agent-failure.test.ts` | Mock agent simulated failure, retry scheduling, and maximum attempt limits | 1 | PASS |
| **Total Unit Tests** | | **37** | **100% PASS** |

---

## 2. Running Automated Tests

Run the full test suite:
```powershell
npm test
```

Expected Output:
```
 ✓ tests/order-state-machine.test.ts (5 tests)
 ✓ tests/mock-agent-failure.test.ts (1 test)
 ✓ tests/page-range.test.ts (11 tests)
 ✓ tests/pricing.test.ts (10 tests)
 ✓ tests/queue-idempotency.test.ts (5 tests)
 ✓ tests/document-inspector.test.ts (5 tests)

 Test Files  6 passed (6)
      Tests  37 passed (37)
```

---

## 3. Phase 1 Master Acceptance Test

To execute the end-to-end acceptance flow without external dependencies:
```powershell
npm run acceptance:phase1
```

### Steps Verified:
1. **Input Validation**: Rejects invalid page ranges ("5-1"), zero copies, and illegal state transitions (`RECEIVED` ➔ `PRINTING`).
2. **Order Creation & Pricing**: Creates order #P1042 (A4 / B&W / Duplex / 2 copies / 12 pages) = ₹48.00 (4800 paisa).
3. **Verified Payment**: Webhook marks order `PAID` and transitions it to `QUEUED`.
4. **Idempotency**: Repeated webhooks for the same order and transaction do NOT create duplicate print jobs.
5. **Atomic Claim**: Two concurrent agents attempt to claim the job simultaneously; exactly one agent claims it, and the other receives null.
6. **Agent Execution**: Mock Print Agent moves order to `PRINTING`, simulates spooling, and marks `COMPLETED`.
7. **Audit Trail & Metrics**: Verifies 8 recorded audit events and updated dashboard revenue & page totals.
