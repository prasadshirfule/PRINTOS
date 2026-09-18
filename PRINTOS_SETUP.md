# PRINTOS — Setup & Local Execution Guide

---

## 1. Prerequisites

- **Node.js**: `v20.x` or `v24.x` (verified on Node `v24.19.0`)
- **Package Manager**: `npm` (`v10.x` or `v11.x`)
- **OS**: Windows, macOS, or Linux (Shop Print Agent physical printer target is Windows)

---

## 2. Quickstart Installation

Clone or open the project folder in terminal:
```powershell
cd C:\Users\prasa\.gemini\antigravity\scratch\printos
npm install
```

---

## 3. Environment Variables Configuration

Create a `.env.local` file in the root directory:
```bash
# Cloud Backend Configuration
NEXT_PUBLIC_APP_URL="http://localhost:3000"
NODE_ENV="development"

# Supabase Credentials (Optional for local development; in-memory store is active by default)
NEXT_PUBLIC_SUPABASE_URL="https://your-supabase-project.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# Print Agent Security Key
PRINTOS_AGENT_KEY="mock-agent-secret-token"
PRINTOS_AGENT_NAME="shop-pc-01"
PRINTOS_API_URL="http://localhost:3000"

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
- **Printers & Agents**: [http://localhost:3000/admin/printers](http://localhost:3000/admin/printers)

---

## 5. Running the Mock Print Agent

In a separate terminal window, launch the Mock Print Agent daemon:
```powershell
npm run agent:mock
```

To test failure simulation (e.g. simulated paper jam and retry behavior):
```powershell
npm run agent:mock:fail
```

---

## 6. Running Tests & Quality Checks

Run the Vitest test suite:
```powershell
npm test
```

Run the Phase 1 Master Acceptance Test:
```powershell
npm run acceptance:phase1
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
