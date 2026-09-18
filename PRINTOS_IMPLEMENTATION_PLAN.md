# PRINTOS — WhatsApp Automated Printing Service
## Architecture & Master Implementation Plan

---

## 1. System Overview

PRINTOS is a production-grade automated printing service designed for print shops. Customers interact via WhatsApp to upload documents, configure print settings, receive deterministic price quotes, and pay via UPI. Upon payment verification, orders are automatically placed in an atomic print queue, claimed by a local Windows Print Agent over authenticated HTTPS, and printed by a physical printer.

---

## 2. High-Level Architecture

```
Customer (WhatsApp)
       │ (Sends PDF/Image & selects options)
       ▼
Cloud Backend (/api/whatsapp/webhook)
       │ (Validates input, extracts metadata, computes price)
       ▼
Order State Machine (RECEIVED ➔ CONFIGURING ➔ AWAITING_PAYMENT)
       │ (Generates UPI Payment Intent)
       ▼
Payment Gateway (/api/payments/webhook)
       │ (Idempotent signature validation & transition to PAID)
       ▼
Print Queue (Atomic Job Creation: Exactly 1 job per order)
       │ (PostgreSQL FOR UPDATE SKIP LOCKED / Atomic RPC)
       ▼
Shop Local Print Agent (HTTPS with Agent API Key)
       │ (Downloads presigned short-lived URL, dispatches to Windows Print Spooler)
       ▼
Physical Printer (USB / Wi-Fi) ➔ Finished Document & WhatsApp Notification
```

---

## 3. Database Entities & Invariants

1. **`printers`**:
   - Manages physical hardware properties (`supports_color`, `supports_duplex`, `supported_paper_sizes`).
   - Dynamically reports `ONLINE` / `OFFLINE` / `BUSY` based on agent heartbeat.
2. **`print_agents`**:
   - Local shop computer daemons with hashed API keys and reported capabilities.
3. **`print_settings`**:
   - Configurable pricing per paper size and color mode in integer **paisa** minor units.
4. **`print_orders`**:
   - Full order lifecycle, customer phone, file specs, copies, page selection, and amounts.
5. **`print_jobs`**:
   - Atomic queue entries with unique constraint on `order_id` (guarantees idempotency).
   - Tracks attempts (`attempt_count`), priority, and error messages.
6. **`payment_transactions`**:
   - Ledger of all gateway callbacks with unique constraint on `(provider, transaction_id)`.
7. **`print_order_events`**:
   - Immutable audit trail recording every state change and customer interaction.

---

## 4. Phase-by-Phase Roadmap

- **Phase 1: Core Foundation & Engine (COMPLETED)**
  - Greenfield Next.js App Router setup with strict TypeScript & Tailwind CSS.
  - Supabase SQL migrations with `claim_next_print_job` stored procedure (`FOR UPDATE SKIP LOCKED`).
  - Deterministic minor-currency (paisa) Pricing Engine.
  - Reusable Page Range Parser & Validator (dedupes, sorts, validates bounds).
  - Strict Order State Machine with transition protections.
  - Document Inspector abstraction with PDF and image inspection.
  - Full Admin Dashboard (`/admin`, `/admin/orders`, `/admin/queue`, `/admin/printers`).
  - Standalone Mock Print Agent with heartbeat, queue claiming, and failure simulation.
  - 100% passing test suite (37 unit tests + end-to-end acceptance suite).

- **Phase 2: WhatsApp Integration & Interactive Conversation Engine**
  - Implement `IWhatsAppService` adapter for OpenWA / Baileys / Cloud API.
  - Conversation state machine persisting conversational steps in database.
  - Document intake webhook, validation, and private Supabase storage uploads.

- **Phase 3: Payment Gateway & Queue Automation**
  - UPI / Razorpay / Cashfree gateway abstraction with signature verification.
  - Webhook idempotency handling and automatic transition to `PAID` / `QUEUED`.

- **Phase 4: Production Windows Print Agent**
  - Native Windows Print Spooler integration (PowerShell / SumatraPDF CLI).
  - Hardware duplex and color capability auto-discovery.
  - Short-lived signed document streaming and automatic cleanup.

- **Phase 5: Production Hardening, Observability & Cleanup**
  - File retention cleanup cron job (`/api/cron/cleanup`).
  - Structured audit logging, rate limiting, and end-to-end security audits.
