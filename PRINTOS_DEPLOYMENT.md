# PRINTOS — Production Deployment Guide

A step-by-step, practical guide for developers, system administrators, and print shop operators deploying PRINTOS to production.

---

## 📋 Architecture Overview

In production, PRINTOS operates across three distinct tiers:

```
[ Customer (WhatsApp) ] ───▶ [ OpenWA / WhatsApp Gateway ]
                                      │ (Inbound Webhook)
                                      ▼
[ Customer (UPI / QR) ] ───▶ [ Next.js Cloud Backend (Vercel) ] ◀───▶ [ Supabase (Postgres + Auth + Storage) ]
                                      ▲
                                      │ (Outbound HTTPS Polling: x-agent-key)
                                      │
                         [ Windows Print Agent (Shop PC) ]
                                      │
                                      ▼
                         [ SumatraPDF / Print Spooler ]
                                      │
                                      ▼
                         [ Physical Printer (USB / LAN) ]
```

1. **Cloud Web & API Tier (Vercel)**: Next.js 14 App Router backend handling customer webhooks, deterministic paisa pricing, admin portal, and atomic queue APIs.
2. **Database & Storage Tier (Supabase)**: Managed PostgreSQL database, Row-Level Security (RLS), atomic job-claiming RPCs, Supabase Auth, and private document storage buckets.
3. **Local Shop Tier (Windows PC)**: Lightweight Node.js background agent connected to physical printers via SumatraPDF / Windows Print Spooler, polling the cloud via outbound HTTPS.

---

## 1. Prerequisites & Accounts

Before starting, prepare the following accounts and resources:

| Resource | Service | Purpose | Required |
| :--- | :--- | :--- | :--- |
| **Hosting Platform** | [Vercel](https://vercel.com/) | Serverless Next.js 14 deployment | **Yes** |
| **Database & Storage** | [Supabase](https://supabase.com/) | PostgreSQL, Auth, and private file storage | **Yes** |
| **Payment Gateway** | [Razorpay](https://razorpay.com/) | Dynamic UPI QR codes and payment webhooks | **Yes** (in India) |
| **WhatsApp Gateway** | [OpenWA](https://openwa.dev/) / Meta Cloud API | Multi-device WhatsApp messaging automation | **Yes** |
| **Shop Computer** | Windows 10 / 11 PC | Runs Windows Print Agent connected to printers | **Yes** |
| **Silent PDF Engine** | [SumatraPDF](https://www.sumatrapdfreader.org/) | Fast, silent CLI printing on shop PC | **Recommended** |
| **Custom Domain** | Any DNS provider (Cloudflare, Namecheap) | SSL-secured custom domain for webhooks | Recommended |

---

## 2. Supabase Setup (Database, Storage & Auth)

### Step 2.1: Create a Supabase Project
1. Log in to [Supabase](https://supabase.com/dashboard) and click **New Project**.
2. Set a project name (e.g., `printos-production`) and a strong database password.
3. Choose a region closest to your print shop location (e.g., `ap-south-1` Mumbai).
4. Note down your project credentials from **Project Settings ➔ API**:
   - `Project URL` (`NEXT_PUBLIC_SUPABASE_URL`)
   - `anon public key` (`NEXT_PUBLIC_SUPABASE_ANON_KEY`)
   - `service_role secret key` (`SUPABASE_SERVICE_ROLE_KEY`)

### Step 2.2: Apply Database Migrations
Run the SQL migration scripts in order using the **SQL Editor** in the Supabase Dashboard:

1. Open `supabase/migrations/00001_initial_schema.sql` ➔ Paste into SQL Editor ➔ Click **Run**.
   - *Creates core enums, tables (`print_orders`, `print_jobs`, `printers`, `print_agents`, `print_settings`), and the atomic `claim_next_print_job` stored procedure.*
2. Open `supabase/migrations/00003_whatsapp_schema.sql` ➔ Paste into SQL Editor ➔ Click **Run**.
   - *Creates WhatsApp inbox, outbox, conversation locks, and message deduplication indexes.*
3. Open `supabase/migrations/00004_multi_shop_schema.sql` ➔ Paste into SQL Editor ➔ Click **Run**.
   - *Enables multi-tenant `shop_id` scoping, Row Level Security (RLS) policies, and multi-tenant RPCs.*

> [!CAUTION]
> **Do NOT run `00002_development_seed.sql` in production.** That script contains dummy development records.

### Step 2.3: Configure Private Document Storage Bucket
1. Go to **Storage** in the Supabase Dashboard.
2. Click **New Bucket**:
   - **Name**: `printos-documents`
   - **Public Bucket**: **OFF** (Keep unchecked — customer documents must remain private).
3. Under Storage **Policies**, ensure that only service-role tokens have read/write permissions.

### Step 2.4: Create the Initial Admin User
1. Go to **Authentication ➔ Users** in the Supabase Dashboard.
2. Click **Add User ➔ Create User**.
3. Enter your staff/admin email and a strong password.
4. Under `User Metadata` (JSON), attach your shop ID:
   ```json
   {
     "shop_id": "00000000-0000-0000-0000-000000000001",
     "role": "admin"
   }
   ```

---

## 3. Production Environment Variables Reference

Generate high-entropy random secrets before configuring the deployment:

```bash
# Generate 32-character secrets on Linux/macOS or Git Bash / PowerShell:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Complete Environment Matrix

| Variable Name | Required | Description / Production Recommendation |
| :--- | :--- | :--- |
| `NODE_ENV` | **Yes** | Set to `"production"`. Activates fail-fast validation. |
| `NEXT_PUBLIC_APP_URL` | **Yes** | Full public domain URL, e.g., `https://printos.yourdomain.com` (no trailing slash). |
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | Supabase project URL (`https://<project-ref>.supabase.co`). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Yes** | Supabase anonymous public key. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Supabase `service_role` secret (used for atomic operations and RLS bypass). |
| `ADMIN_JWT_SECRET` | **Yes** | High-entropy random secret (32+ characters) for admin session cookies. |
| `ADMIN_EMAIL` | **Yes** | Primary admin email address. **Cannot be `admin@printos.local`**. |
| `ADMIN_PASSWORD` | **Yes** | Fallback local admin password. **Cannot be `admin123`**. |
| `PRINTOS_AGENT_KEY` | **Yes** | Cryptographically random key (16+ chars) shared with shop PC print agent. |
| `CRON_SECRET` | **Yes** | Unique bearer token protecting `/api/cron/*` maintenance endpoints. |
| `PAYMENT_PROVIDER` | **Yes** | Set to `"razorpay"` for live UPI transactions. |
| `RAZORPAY_KEY_ID` | **Yes** | Razorpay Live Key ID (`rzp_live_...`). |
| `RAZORPAY_KEY_SECRET` | **Yes** | Razorpay Live Key Secret. |
| `RAZORPAY_WEBHOOK_SECRET` | **Yes** | Secret configured in Razorpay Webhooks dashboard. |
| `UPI_MERCHANT_VPA` | **Yes** | Shop UPI VPA address (e.g., `shopname@icici` or `9876543210@paytm`). |
| `UPI_MERCHANT_NAME` | **Yes** | Business name displayed on customer UPI payment screens. |
| `WHATSAPP_PROVIDER` | **Yes** | Set to `"openwa"` or `"meta"`. |
| `OPENWA_API_URL` | Optional | URL of your OpenWA HTTP API server (if using OpenWA). |
| `OPENWA_API_KEY` | Optional | API key for OpenWA server. |
| `OPENWA_WEBHOOK_SECRET` | Optional | HMAC secret for verifying inbound WhatsApp webhooks. |

---

## 4. Deploying Next.js to Vercel

### Option A: Deploy via Vercel Web Dashboard (Recommended)

1. Push your repository to GitHub (ensure branch is `main`).
2. Log in to [Vercel](https://vercel.com/) and click **Add New ➔ Project**.
3. Import your `PRINTOS` repository.
4. Keep the default settings:
   - **Framework Preset**: Next.js
   - **Root Directory**: `./`
   - **Build Command**: `next build` (or `npm run build`)
   - **Output Directory**: `.next`
5. Expand **Environment Variables** and add all production variables listed in [Section 3](#3-production-environment-variables-reference).
6. Click **Deploy**.

### Option B: Deploy via Vercel CLI

```powershell
# Install Vercel CLI globally
npm install -g vercel

# Link and deploy to production
vercel --prod
```

### Verify Deployment
Once deployed, verify the public health endpoint:
```bash
curl https://printos.yourdomain.com/api/health
```
Expected JSON response:
```json
{
  "status": "healthy",
  "version": "0.1.0",
  "repository": "SupabasePostgresRepository",
  "environment": "production",
  "uptime": 42.1
}
```

---

## 5. Configuring Payment Webhooks (Razorpay)

1. Log in to the [Razorpay Dashboard](https://dashboard.razorpay.com/).
2. Switch to **Live Mode** in the top navigation bar.
3. Navigate to **Account & Settings ➔ Webhooks**.
4. Click **Add New Webhook**:
   - **Webhook URL**: `https://printos.yourdomain.com/api/webhooks/payment`
   - **Secret**: The exact string used for `RAZORPAY_WEBHOOK_SECRET`.
   - **Alert Email**: Your operational support email.
   - **Active Events**:
     - `payment.captured`
     - `order.paid`
5. Click **Create Webhook**.

---

## 6. Configuring WhatsApp Gateway (OpenWA)

When using [OpenWA](https://openwa.dev/) as your WhatsApp gateway:

1. Deploy OpenWA Docker container on a VPS or shop server:
   ```bash
   docker run -d \
     --name openwa-printos \
     -p 8080:8080 \
     -e AUTH_KEY="your-openwa-api-key" \
     -e WEBHOOK_URL="https://printos.yourdomain.com/api/webhooks/whatsapp" \
     -e WEBHOOK_SECRET="your-openwa-webhook-secret" \
     openwa/wa-automate
   ```
2. Open the OpenWA web console and scan the QR code using your shop's WhatsApp business number.
3. Inbound documents and commands sent by customers will now forward to `/api/webhooks/whatsapp`.

---

## 7. Setting Up Maintenance Cron Jobs

PRINTOS requires two scheduled cron endpoints:
1. **Queue Processor (`/api/cron/process-queues`)**: Dispatches pending WhatsApp outbox messages and updates order states. (Run every 1–2 minutes).
2. **Storage Cleanup (`/api/cron/cleanup`)**: Permanently purges customer files older than `retentionHours` (default 24h) for data privacy. (Run once daily).

### Option A: Using Vercel Cron Jobs (`vercel.json`)
Add a `vercel.json` file in the project root:

```json
{
  "crons": [
    {
      "path": "/api/cron/process-queues",
      "schedule": "* * * * *"
    },
    {
      "path": "/api/cron/cleanup?retentionHours=24",
      "schedule": "0 3 * * *"
    }
  ]
}
```
*Note: Vercel automatically attaches `CRON_SECRET` headers to verified cron triggers.*

### Option B: Using External Cron (Cron-Job.org / Cloudflare Workers / UptimeRobot)
Configure HTTP POST requests to your endpoints with the `Authorization` header:

```bash
# Queue processing trigger
curl -X POST "https://printos.yourdomain.com/api/cron/process-queues" \
  -H "Authorization: Bearer your-secure-cron-secret-token"

# Daily file cleanup trigger
curl -X POST "https://printos.yourdomain.com/api/cron/cleanup?retentionHours=24" \
  -H "Authorization: Bearer your-secure-cron-secret-token"
```

---

## 8. Setting Up the Windows Print Agent on Shop PC

The **Windows Print Agent** runs locally on the shop counter computer connected to physical USB/LAN printers.

### Step 8.1: Install Prerequisites on Shop PC
1. **Node.js LTS (v20+)**: Download from [nodejs.org](https://nodejs.org/).
2. **SumatraPDF**: Download and install SumatraPDF 64-bit from [sumatrapdfreader.org](https://www.sumatrapdfreader.org/).
   - Default install path: `C:\Program Files\SumatraPDF\SumatraPDF.exe`.
3. **Printers**: Ensure physical printers (e.g. Canon, HP, Epson) are installed in Windows and configured as default or identifiable by name.

### Step 8.2: Setup Project on Shop PC
1. Clone or copy the PRINTOS repository to the shop PC (e.g., `C:\printos-agent`):
   ```powershell
   git clone https://github.com/prasadshirfule/PRINTOS.git C:\printos-agent
   cd C:\printos-agent
   npm install --omit=dev
   ```

2. Create a `.env.local` configuration file:
   ```bash
   # Production Cloud API URL
   PRINTOS_API_URL="https://printos.yourdomain.com"

   # Secret Key matching the cloud PRINTOS_AGENT_KEY
   PRINTOS_AGENT_KEY="your-secure-agent-secret-key-12345"
   PRINTOS_AGENT_NAME="shop-counter-pc-01"

   # Optional: Force a specific printer name (omitted = Windows Default)
   # PRINT_AGENT_PRINTER_NAME="Canon MF3010"

   # Poll interval in milliseconds (default: 1500)
   PRINT_AGENT_POLL_INTERVAL_MS="1500"
   ```

3. Test run the agent:
   ```powershell
   npm run agent:windows
   ```
   You should see:
   ```
   [WindowsPrintAgent] Initialized on host: SHOP-PC (win32)
   [WindowsPrintAgent] Discovered 1 printer(s): Canon MF3010
   [WindowsPrintAgent] Heartbeat sent successfully (Status: ONLINE)
   [WindowsPrintAgent] Polling for pending print jobs...
   ```

### Step 8.3: Run Agent Continuously as a Windows Service

To ensure the agent starts automatically on system boot and restarts on unexpected errors, use **PM2** with `pm2-windows-service`:

```powershell
# 1. Install PM2 and Windows service helper
npm install -g pm2 pm2-windows-service

# 2. Configure PM2 Windows service
pm2-service-install -n "PRINTOS-Agent"

# 3. Start the Windows Print Agent via PM2
cd C:\printos-agent
pm2 start "npm run agent:windows" --name "printos-agent"

# 4. Save the running process list
pm2 save
```

Alternatively, use Windows **Task Scheduler**:
- Action: Start a program: `powershell.exe`
- Arguments: `-ExecutionPolicy Bypass -WindowStyle Hidden -Command "cd C:\printos-agent; npm run agent:windows"`
- Trigger: *At log on of any user* (or *At system startup*).

---

## 9. Post-Deployment Launch Checklist

Before opening the service to customers, complete this verification checklist:

- [ ] **Health Endpoint**: `GET /api/health` returns `HTTP 200` with `status: healthy` and `SupabasePostgresRepository`.
- [ ] **Security Validation**: Confirm that default development credentials (`admin@printos.local` / `admin123`) are **rejected** in production.
- [ ] **Admin Portal**: Log in at `https://printos.yourdomain.com/admin/login` using your Supabase staff credentials.
- [ ] **Hardware Status**: Verify that the shop printer displays as `ONLINE` with green telemetry indicators on `/admin/printers`.
- [ ] **WhatsApp Ingestion**: Send a test PDF document to the WhatsApp business number and receive an interactive quote with pricing in paisa.
- [ ] **Payment Simulation & Webhook**: Complete a test payment via UPI QR; verify the order transitions to `QUEUED` and creates a `print_jobs` entry.
- [ ] **Physical Printout**: Verify the Windows Print Agent downloads the stream, prints silently via SumatraPDF, and marks the job `COMPLETED`.
- [ ] **File Lifecycle Cleanup**: Verify that temporary files in `os.tmpdir()/printos-agent-spool` are deleted immediately after spooling.
- [ ] **Cron Execution**: Trigger `/api/cron/cleanup` and confirm expired storage records are deleted without errors.

---

## 10. Troubleshooting & Common Issues

### 1. `[CRITICAL PRODUCTION CONFIGURATION ERROR]` on Startup
- **Cause**: One or more required environment variables are missing, or insecure placeholder secrets were detected by `ProductionEnvValidator`.
- **Fix**: Check Vercel build/runtime logs. Ensure secrets like `ADMIN_JWT_SECRET`, `PRINTOS_AGENT_KEY`, and `CRON_SECRET` are at least 16 characters long and do not contain default words like `your-secure-admin-session-secret` or `admin123`.

### 2. Print Agent Returns `401 / 403 Invalid agent token`
- **Cause**: The `PRINTOS_AGENT_KEY` on the shop PC `.env.local` does not match the `PRINTOS_AGENT_KEY` set in Vercel environment variables.
- **Fix**: Re-copy the exact secret to both environments and restart the agent process (`pm2 restart printos-agent`).

### 3. SumatraPDF Not Detected (PowerShell Spooler Fallback Used)
- **Cause**: SumatraPDF is not installed or not located in the default `C:\Program Files\SumatraPDF\SumatraPDF.exe` path.
- **Fix**: Install SumatraPDF to the default directory or specify `SUMATRA_PDF_PATH="C:\Path\To\SumatraPDF.exe"` in `.env.local`.

### 4. Razorpay Webhook `400 Invalid signature`
- **Cause**: The `RAZORPAY_WEBHOOK_SECRET` in Vercel does not match the secret entered in the Razorpay Webhooks dashboard.
- **Fix**: Synchronize the webhook secret in both Razorpay Dashboard and Vercel environment settings.

### 5. Supabase RLS / Permission Denied on Stored Procedures
- **Cause**: `SUPABASE_SERVICE_ROLE_KEY` is missing or the database migrations (`00001_initial_schema.sql` through `00004_multi_shop_schema.sql`) were not applied.
- **Fix**: Run the migrations via the Supabase SQL editor and verify that `SUPABASE_SERVICE_ROLE_KEY` is set in Vercel.

---

## 📞 Support & Maintenance

For issues, bug reports, and contributions, visit the [PRINTOS GitHub Repository](https://github.com/prasadshirfule/PRINTOS).
