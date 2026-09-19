# PRINTOS — Setup & Local Execution Guide

---

## 1. Prerequisites

- **Node.js**: `v20.x` or `v24.x` (verified on Node `v24.19.0`)
- **Package Manager**: `npm` (`v10.x` or `v11.x`)
- **OS**: Windows, macOS, or Linux (Native Windows Print Agent runs on Windows)
- **PDF Engine (Optional for Windows physical printing)**: SumatraPDF (recommended for silent printing)

---

## 2. Quickstart Installation

Clone or open the project folder in terminal:
```powershell
git clone https://github.com/prasadshirfule/PRINTOS.git
cd PRINTOS
npm install
```

---

## 3. Environment Variables Configuration

Create a `.env.local` file in the root directory:
```bash
# Cloud Backend Configuration
NEXT_PUBLIC_APP_URL="http://localhost:3000"
NODE_ENV="development"

# Multi-Shop / Tenant Configuration
# DEFAULT_SHOP_ID="00000000-0000-0000-0000-000000000001"

# Admin Authentication & Security
# ⚠️ DEVELOPMENT ONLY — All values below MUST be changed before production deployment.
# ProductionEnvValidator will block startup if these defaults are detected in production.
ADMIN_EMAIL="admin@printos.local"        # Replace with a real admin email in production
ADMIN_PASSWORD="admin123"                 # Replace with a strong password in production
ADMIN_JWT_SECRET="your-secure-admin-session-secret"  # Replace with 32+ char random secret

# Print Agent Security Key
# ⚠️ DEVELOPMENT ONLY — use a cryptographically random string (16+ chars) in production
PRINTOS_AGENT_KEY="mock-agent-secret-token"
PRINTOS_AGENT_NAME="shop-pc-01"
PRINTOS_API_URL="http://localhost:3000"

# Optional: Preferred Physical Printer Name (defaults to Windows default)
# PRINT_AGENT_PRINTER_NAME="Canon MF3010"

# Cron Job Security Token
# ⚠️ DEVELOPMENT ONLY — set a unique secret in production
CRON_SECRET="your-secure-cron-secret-token"

# Optional: Razorpay Production Credentials (Mock provider used if omitted)
# PAYMENT_PROVIDER="razorpay"
# RAZORPAY_KEY_ID="rzp_live_..."
# RAZORPAY_KEY_SECRET="your_key_secret"
# RAZORPAY_WEBHOOK_SECRET="your_webhook_secret"
# UPI_MERCHANT_VPA="printos@upi"
# UPI_MERCHANT_NAME="PRINTOS Print Shop"

# Optional: Supabase Credentials (Optional for local dev; in-memory store active by default)
# NEXT_PUBLIC_SUPABASE_URL="https://your-supabase-project.supabase.co"
# NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"
# SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# Mock Failure Simulation (Set to "true" to test paper jam / hardware error)
PRINT_AGENT_MOCK_FAILURE="false"
```

---

## 4. Multi-Shop / Multi-Tenancy Architecture

PRINTOS natively supports **Multi-Shop Tenant Isolation**:
- **Tenant Scope**: Every core entity (`print_orders`, `print_jobs`, `printers`, `print_agents`, `print_settings`, `whatsapp_conversations`) is scoped by `shop_id`.
- **Database Row Level Security (RLS)**: Enforced via `00004_multi_shop_schema.sql` on Supabase / PostgreSQL.
- **Default Flagship Shop**: For seamless single-shop development and local testing, PRINTOS bootstraps `DEFAULT_SHOP_ID = '00000000-0000-0000-0000-000000000001'` (`PRINTOS Flagship Shop`).
- **Admin Session Binding**: Admin session cookies carry the staff user's `shopId`. The admin dashboard automatically renders only metrics, print queues, orders, and hardware for the assigned shop.
- **Agent Job Isolation**: When local Windows Print Agents claim jobs atomically via `/api/agent/jobs/claim`, jobs are strictly filtered by the agent's shop.

---

## 5. Admin Portal & Authentication

The `/admin/*` portal is fully protected by Next.js middleware and signed session tokens stored in secure `httpOnly` cookies (`printos_admin_session`).

> [!WARNING]
> **Default Credentials Warning**: The default credentials below are provided strictly for local development and offline testing. In any staging or production environment, `ProductionEnvValidator` will block execution if default passwords or mock secrets are detected. Always configure secure secrets in production.

### Logging In (Development Mode)
1. Start the server (`npm run dev`) and visit [http://localhost:3000/admin](http://localhost:3000/admin).
2. Unauthenticated requests are automatically redirected to the portal login at `/admin/login`.
3. Default credentials for local development:
   - **Email**: `admin@printos.local`
   - **Password**: `admin123`
4. Once authenticated, staff can view live queues, orders, and printer telemetry, or click **Sign Out** to destroy the active session.

### Creating Production Admin Users (Supabase Auth)
For production deployments using Supabase:
1. Navigate to your Supabase Dashboard ➔ **Authentication** ➔ **Users**.
2. Click **Add User** (or `Invite User`) and create an admin account with staff email and a strong password.
3. To assign a specific shop to a staff member, include `"shop_id": "<shop-uuid>"` in `user_metadata`.
4. PRINTOS automatically queries `supabase.auth.signInWithPassword` first, generating signed session cookies with the tenant's `shopId`.

---

## 6. Production vs Development Mode

| Feature | Development (`NODE_ENV=development`) | Production (`NODE_ENV=production`) |
| :--- | :--- | :--- |
| **Database** | In-memory repository (no Supabase required) | Supabase PostgreSQL (required) |
| **Payment Gateway** | `MockPaymentProvider` (no real charges) | `RazorpayPaymentProvider` (live UPI) |
| **WhatsApp** | `MockWhatsAppProvider` (no real messages) | `OpenWA` / Meta Cloud API (live) |
| **Admin Auth** | Local fallback credentials accepted | Supabase Auth or strong local credentials enforced |
| **Document Storage** | In-memory / mock document buffer | Private Supabase Storage with signed URLs |
| **Env Validation** | Warnings only (non-blocking) | Fail-fast on insecure defaults (blocks startup) |
| **Login Page** | Default credential hints shown | Credential hints hidden |

---

## 7. Production Deployment & Security Guide

> [!TIP]
> **Complete Production Deployment Guide**: For the full, step-by-step production walkthrough covering Vercel, Supabase, Razorpay webhooks, OpenWA, and running the Windows Print Agent as an autostart background service, see [**PRINTOS_DEPLOYMENT.md**](./PRINTOS_DEPLOYMENT.md).

Before deploying PRINTOS to production (e.g. Vercel, Railway, AWS):

1. **Environment Variables**:
   - Ensure `NODE_ENV="production"` is set.
   - `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must point to your live Supabase instance.
   - `ADMIN_JWT_SECRET` must be set to a high-entropy secret (min 32 characters).
   - `ADMIN_EMAIL` must NOT be `admin@printos.local` — set a real admin email address.
   - `ADMIN_PASSWORD` (if using local auth fallback) must NOT be `admin123`.
   - `PRINTOS_AGENT_KEY` must be a cryptographically secure random string shared only with your local Windows Print Agent PCs.
   - `CRON_SECRET` must be set to protect `/api/cron/*` endpoints from unauthorized triggers.
   - Do NOT copy placeholder values like `your-secure-admin-session-secret` or `your-secure-cron-secret-token` verbatim — generate unique secrets.
   - Configure live Razorpay API keys (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`).

2. **Database Migrations**:
   - Run migrations `00001_initial_schema.sql` through `00004_multi_shop_schema.sql` in your Supabase SQL editor (do NOT run `00002_development_seed.sql` in production).

3. **Uptime & Health Monitoring**:
   - Monitor the public health check endpoint at `/api/health` using UptimeRobot, BetterStack, or Datadog. It returns HTTP 200 with repository and system telemetry.

---

## 8. Running the Development Server

Start the Next.js application:
```powershell
npm run dev
```

Open your browser at:
- **Admin Portal**: [http://localhost:3000/admin](http://localhost:3000/admin)
- **Login Portal**: [http://localhost:3000/admin/login](http://localhost:3000/admin/login)
- **All Orders**: [http://localhost:3000/admin/orders](http://localhost:3000/admin/orders)
- **Live Print Queue**: [http://localhost:3000/admin/queue](http://localhost:3000/admin/queue)
- **Printers & Telemetry**: [http://localhost:3000/admin/printers](http://localhost:3000/admin/printers)

---

## 9. Running the Print Agent

### Production: Native Windows Print Agent
Runs on the shop Windows PC connected to physical USB/LAN printers:
```powershell
npm run agent:windows
```

### Development: Mock Print Agent
Runs simulated printing without physical printers:
```powershell
# Standard mock agent daemon (1-second print duration, 10s heartbeats)
npm run agent:mock

# Simulated failure mode (tests paper jam, retry backoff & terminal failure)
npm run agent:mock:fail
```

---

## 10. Running Cron Maintenance Jobs

PRINTOS includes automated cron endpoints protected by `CRON_SECRET`:

### Queue Worker (Process Inbox & Outbox Messages)
```bash
curl -X POST http://localhost:3000/api/cron/process-queues -H "Authorization: Bearer your-secure-cron-secret-token"
```

### File Retention & Document Storage Purge (Default 24h)
```bash
curl -X POST "http://localhost:3000/api/cron/cleanup?retentionHours=24" -H "Authorization: Bearer your-secure-cron-secret-token"
```

---

## 11. Running Tests & Quality Checks

Run the full Vitest automated test suite (22 test files, 120 tests):
```powershell
npm test
```

Run Phase 1 Master Acceptance Test:
```powershell
npm run acceptance:phase1
```

Run Phase 2 WhatsApp Ingestion Acceptance Test (34 scenarios):
```powershell
npm run acceptance:phase2
```

Run TypeScript and ESLint checks:
```powershell
npx tsc --noEmit
npm run lint
```

Build for production:
```powershell
npm run build
```
