# PRINTOS — Real-World Testing & Soft Launch Checklist

A practical, step-by-step verification checklist for developers, system administrators, and print shop owners before opening PRINTOS to live customers.

---

## 🎯 Purpose of this Checklist

Use this checklist to methodically validate the full end-to-end system — from customer WhatsApp document submission and UPI payment to physical silent printing on the shop counter — verifying zero regressions, solid security, and smooth edge-case handling.

---

## A. 🛠️ Pre-Launch Setup Checklist

Before initiating functional tests, verify that all underlying infrastructure, accounts, and hardware are properly configured.

### 1. Database & Persistence (Supabase)
- [ ] Supabase project is active in a low-latency region (e.g., Mumbai `ap-south-1`).
- [ ] Core database schema migration `00001_initial_schema.sql` applied successfully.
- [ ] WhatsApp inbox & outbox migration `00003_whatsapp_schema.sql` applied successfully.
- [ ] Multi-tenancy migration `00004_multi_shop_schema.sql` applied successfully.
- [ ] Development seed (`00002_development_seed.sql`) is **NOT** applied in production.
- [ ] Private document storage bucket `print-documents` created with **Public = False** (overrideable via `PRINTOS_STORAGE_BUCKET`).
- [ ] Supabase Auth configured with initial admin/staff user and `shop_id` metadata.

### 2. Cloud Backend Deployment (Vercel)
- [ ] Production build succeeds with 0 errors (`npm run build`).
- [ ] All production environment variables configured in Vercel project settings.
- [ ] `NODE_ENV` is set to `"production"`.
- [ ] `ProductionEnvValidator` passes without throwing configuration exceptions.
- [ ] Custom domain or production URL HTTPS SSL certificate is valid.
- [ ] Health check endpoint `GET /api/health` returns HTTP 200 with `status: "healthy"` and repository `"SupabasePostgresRepository"`.

### 3. Payment Gateway (Razorpay)
- [ ] Razorpay account is activated (Test Mode for staging, Live Mode for production).
- [ ] API keys (`RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`) configured.
- [ ] Webhook URL registered: `https://your-domain.com/api/webhooks/payment`.
- [ ] Webhook secret matches `RAZORPAY_WEBHOOK_SECRET`.
- [ ] Active webhook events subscribed: `payment.captured` and `order.paid`.
- [ ] UPI Merchant VPA (`UPI_MERCHANT_VPA`) and Name (`UPI_MERCHANT_NAME`) configured.

### 4. WhatsApp Gateway (OpenWA / Meta Cloud API)
- [ ] OpenWA server container running and connected to shop WhatsApp Business number.
- [ ] Inbound webhook forwarded to `https://your-domain.com/api/webhooks/whatsapp`.
- [ ] HMAC signature verification secret configured (`OPENWA_WEBHOOK_SECRET`).
- [ ] Bot responds to test greeting ("Hi" / "Hello").

### 5. Shop Counter Hardware & Print Agent
- [ ] Windows PC connected to physical USB / LAN printers.
- [ ] Node.js (v20+ LTS) installed on shop PC.
- [ ] SumatraPDF (64-bit) installed at `C:\Program Files\SumatraPDF\SumatraPDF.exe`.
- [ ] Printer paper trays filled with clean A4 / Legal paper.
- [ ] Ink / toner levels checked and adequate for printing.
- [ ] Windows Print Agent `.env.local` configured with matching `PRINTOS_AGENT_KEY`.
- [ ] Agent service started and shows `ONLINE` on `/admin/printers`.
- [ ] Autostart configured via PM2 (`pm2-windows-service`) or Windows Task Scheduler.

### 6. Admin Portal Verification
- [ ] Admin login loads at `/admin/login`.
- [ ] Authenticated staff can log in securely.
- [ ] Flagship or branch shop displays on `/admin/shops`.
- [ ] Physical printer displays on `/admin/printers` with green telemetry.

---

## B. 🧪 End-to-End Functional Tests

Execute this complete customer journey to verify that all modules communicate properly.

### 1. Document Submission
- [ ] Send a multi-page PDF document (e.g. 5-page sample assignment) to the WhatsApp number.
- [ ] Bot replies immediately with receipt confirmation, detecting filename, file format, and page count accurately.

### 2. Conversational Configuration Flow
- [ ] Select Color Mode: Choose **Black & White (B&W)**.
- [ ] Select Sides: Choose **Double-Sided (Duplex)**.
- [ ] Select Copies: Choose **1 Copy**.
- [ ] Select Page Selection: Choose **All Pages** (or specific range `1-3`).
- [ ] Verify the bot transitions states properly (`AWAITING_DOCUMENT` ➔ `AWAITING_CONFIG` ➔ `AWAITING_PAYMENT`).

### 3. Price Quote & UPI Payment Link
- [ ] Verify calculated price matches the configured shop rate matrix in integer paisa.
- [ ] Bot delivers an instant payment message with:
  - Total amount in Rupees (e.g. `₹7.00`).
  - Dynamic NPCI UPI QR code image / payload.
  - Direct UPI Intent payment link (`upi://pay?...`).

### 4. Payment Execution & Webhook Ingestion
- [ ] Scan the QR code or click the intent link using a UPI app (Google Pay / PhonePe / Paytm / BHIM).
- [ ] Complete the payment transaction.
- [ ] Payment webhook receives `payment.captured` event.
- [ ] Webhook verifies HMAC-SHA256 signature and validates exact paisa amount.
- [ ] Order status atomically transitions from `AWAITING_PAYMENT` ➔ `PAID` ➔ `QUEUED`.
- [ ] Print job record (`print_jobs`) created with status `QUEUED`.

### 5. Job Claiming & Physical Silent Printing
- [ ] Windows Print Agent detects the new job on its poll loop.
- [ ] Agent claims the job atomically via PostgreSQL RPC `claim_next_print_job`.
- [ ] Job status transitions to `CLAIMED` ➔ `PRINTING`.
- [ ] Agent fetches document stream securely into temporary spool buffer.
- [ ] SumatraPDF silently prints document to the physical printer with duplex and monochrome flags.
- [ ] Printout ejects from the printer cleanly with correct page count and orientation.

### 6. Post-Print Cleanup & Confirmation
- [ ] Agent reports `COMPLETED` status update back to cloud API.
- [ ] Temporary file deleted from local PC spool directory (`os.tmpdir()/printos-agent-spool`).
- [ ] Customer receives automated completion WhatsApp message: *"Your document has been printed successfully! Please collect it from the counter."*
- [ ] Admin Dashboard reflects updated statistics: Today's Orders +1, Pages Printed +5, Revenue +₹7.00.

---

## C. 🛡️ Failure & Edge Case Tests

Test that the system fails gracefully under real-world errors and network disruptions.

### 1. File Type & Content Validation
- [ ] Send an unsupported file format (e.g. `.exe`, `.zip`, `.mp3`).
- [ ] Verify the bot rejects the file with a helpful error message asking for PDF/JPG/PNG.
- [ ] Send a corrupt/unreadable PDF.
- [ ] Verify document inspector catches the corrupt header and prompts the user to re-upload.

### 2. Payment Amount Tampering
- [ ] Trigger a simulated webhook with a modified lower amount (e.g. expected 5000 paisa, sent 100 paisa).
- [ ] Verify `/api/webhooks/payment` rejects the payload with HTTP 400 `Payment amount mismatch detected` and refuses to queue the print job.

### 3. Webhook Idempotency & Duplicate Deliveries
- [ ] Send the exact same payment webhook payload twice (simulating payment gateway retry).
- [ ] Verify the second webhook is acknowledged with `isDuplicate: true` and does **not** create duplicate print jobs or double prints.

### 4. Printer Offline / Hardware Jam
- [ ] Turn off the printer power switch or disconnect the USB cable.
- [ ] Complete an order payment.
- [ ] Verify the job remains in queue safely or transitions to `RETRY_PENDING`.
- [ ] Reconnect / power ON the printer.
- [ ] Verify the agent reconnects, detects the printer, claims the job, and prints successfully.

### 5. Agent Crash & Restart Recovery
- [ ] Terminate the Print Agent process while idle.
- [ ] Restart the agent process (`npm run agent:windows` or `pm2 restart printos-agent`).
- [ ] Verify the agent re-authenticates with the cloud and resumes polling without duplicate job claims.

### 6. Order Expiration & Late Payment
- [ ] Create an order and leave it unpaid for >30 minutes (until expired).
- [ ] Verify the order transitions to `EXPIRED`.
- [ ] If payment arrives late, verify the late payment handler checks printer hardware fulfillability before queueing.

---

## D. 🔒 Security & Privacy Verification

Ensure customer files and administrative controls are strictly protected.

- [ ] **Admin Route Protection**: Accessing `/admin`, `/admin/orders`, `/admin/queue`, `/admin/printers`, or `/admin/shops` without a session cookie redirects to `/admin/login`.
- [ ] **Default Credential Rejection**: `ProductionEnvValidator` blocks application startup if `admin@printos.local` or `admin123` is configured when `NODE_ENV=production`.
- [ ] **Agent Key Authentication**: Outbound `/api/agent/*` endpoints reject requests without a valid `x-agent-key` header with HTTP 401/403.
- [ ] **Private Storage Security**: Customer files in Supabase Storage cannot be accessed via public browser URLs without a signed short-lived token.
- [ ] **Local Spool Privacy**: Shop counter PC temporary spool directory contains 0 lingering customer files after print jobs complete.
- [ ] **Automated File Retention Purge**: Test triggering `/api/cron/cleanup` with `retentionHours=24` and confirm expired storage files are purged.

---

## E. 🚀 Soft Launch Strategy (Go-Live Plan)

Follow this conservative rollout strategy for the first week of live operation:

### Phase 1: Internal Staff Testing (Day 1)
- [ ] Keep the system enabled for **1 flagship shop only**.
- [ ] Run 5 test printouts using counter staff phones with real UPI payments (₹1 to ₹5).
- [ ] Verify paper tray alignment, print margins, and duplex flipping orientation on physical hardware.

### Phase 2: Pilot Customers (Days 2–3)
- [ ] Place a counter tent card with the shop WhatsApp QR code: *"Skip the Queue — Send your PDF to WhatsApp and Print Instantly"*.
- [ ] Invite 10–20 regular walk-in customers to test the automated WhatsApp flow.
- [ ] Have counter staff actively monitor the live queue at `/admin/queue` during transactions.
- [ ] Solicit direct customer feedback on the speed and clarity of WhatsApp prompts.

### Phase 3: Monitoring & Fine-Tuning (Days 4–7)
- [ ] Monitor daily revenue reconciliation against UPI merchant settlement reports.
- [ ] Check server logs for any unexpected HTTP 500 errors or rate limits.
- [ ] Verify nightly cron cleanup runs and keeps database storage size stable.
- [ ] Adjust page pricing, duplex discounts, or volume discount thresholds on `/admin/shops` as needed.

### Phase 4: Full Multi-Shop Rollout
- [ ] Once the flagship shop operates smoothly for 7 consecutive days, add additional branch shops via `/admin/shops`.
- [ ] Install the Windows Print Agent on secondary shop PCs with branch-specific `PRINTOS_AGENT_KEY` credentials.

---

*PRINTOS — Automated, Secure & Reliable Self-Service Printing for Modern Print Shops.*
