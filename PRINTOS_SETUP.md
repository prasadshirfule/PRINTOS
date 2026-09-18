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

# Print Agent Security Key
PRINTOS_AGENT_KEY="mock-agent-secret-token"
PRINTOS_AGENT_NAME="shop-pc-01"
PRINTOS_API_URL="http://localhost:3000"

# Optional: Preferred Physical Printer Name (defaults to Windows default)
# PRINT_AGENT_PRINTER_NAME="Canon MF3010"

# Cron Job Security Token
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

## 4. Running the Development Server

Start the Next.js application:
```powershell
npm run dev
```

Open your browser at:
- **Admin Dashboard**: [http://localhost:3000/admin](http://localhost:3000/admin)
- **All Orders**: [http://localhost:3000/admin/orders](http://localhost:3000/admin/orders)
- **Live Print Queue**: [http://localhost:3000/admin/queue](http://localhost:3000/admin/queue)
- **Printers & Telemetry**: [http://localhost:3000/admin/printers](http://localhost:3000/admin/printers)

---

## 5. Running the Print Agent

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

## 6. Running Cron Maintenance Jobs

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

## 7. Running Tests & Quality Checks

Run the full Vitest automated test suite (19 test files, 101+ tests):
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
