# PRINTOS — Windows Print Agent Specification & Operator Guide

---

## 1. Print Agent Architecture & Security Model

To ensure physical shop security and cloud reliability:
**The cloud server NEVER directly touches the physical USB or LAN printer.**

Instead, the local shop PC runs the isolated **Print Agent daemon**:
```
Cloud Backend API (/api/agent/*)
         ▲
         │ (Outbound HTTPS polling & heartbeats with x-agent-key)
         │
   Native Windows Print Agent (Local Shop PC)
         │
         ▼
Windows Print Subsystem (SumatraPDF CLI / Native PowerShell Spooler)
         │
         ▼
Physical Printer (USB / LAN / Wi-Fi)
```

### Key Architectural Invariants
1. **Zero-Trust Network Access**: The Print Agent never holds database credentials, Supabase service-role keys, or administrative access.
2. **Authenticated HTTPS**: The agent authenticates solely via the `x-agent-key` header matching the shop's hashed token.
3. **Atomic Queue Claiming**: Claiming is executed cloud-side via PostgreSQL stored procedure (`FOR UPDATE SKIP LOCKED`).
4. **Ephemeral Document Download**: Documents are fetched via short-lived presigned URLs directly into a temporary local spool buffer (`os.tmpdir()/printos-agent-spool`), strictly cleaned up immediately after spooling.
5. **No Lingering Files**: Customer documents are deleted from disk in a `finally` block regardless of print success or failure.

---

## 2. Windows Installation & Prerequisites

### Step 1: Install Node.js
Ensure Node.js (`v20.x` or higher) is installed on the local shop computer.

### Step 2: Install SumatraPDF (Recommended for Silent Printing)
SumatraPDF provides ultra-fast, silent background printing for PDF documents with precise duplex, color, and page range flags.

- Download SumatraPDF (64-bit installer or portable): [https://www.sumatrapdfreader.org/download-free-pdf-viewer](https://www.sumatrapdfreader.org/download-free-pdf-viewer)
- Default installation path: `C:\Program Files\SumatraPDF\SumatraPDF.exe`
- *Note:* If SumatraPDF is not installed, the agent automatically falls back to the native Windows PowerShell Spooler (`Start-Process -Verb PrintTo`).

---

## 3. Configuration & Environment Variables

Configure the agent using `.env.local` or environment variables on the shop PC:

```bash
# Cloud Backend Target
PRINTOS_API_URL="https://your-printos-domain.com"

# Agent Security Credentials
PRINTOS_AGENT_KEY="your-secret-agent-api-key"
PRINTOS_AGENT_NAME="shop-counter-pc-01"

# Target Physical Printer (Optional: defaults to Windows Default Printer)
# PRINT_AGENT_PRINTER_NAME="Canon MF3010 (Copy 1)"

# Path to SumatraPDF CLI (Optional: auto-detected if in standard Program Files or PATH)
# SUMATRA_PDF_PATH="C:\Program Files\SumatraPDF\SumatraPDF.exe"

# Polling Interval in milliseconds
PRINT_AGENT_POLL_INTERVAL_MS="1500"
```

---

## 4. Running the Agent

### A. Production Mode (Native Windows Agent)
Runs the production Windows Print Agent connected to physical hardware:

```powershell
npm run agent:windows
```

#### Startup Sequence:
1. Discovers installed Windows printers and hardware capabilities (`Get-CimInstance Win32_Printer`).
2. Checks availability of SumatraPDF silent print engine.
3. Sends initial heartbeat with printer status (`ONLINE`) and supported paper/duplex capabilities.
4. Enters non-blocking poll loop claiming pending jobs from the cloud queue.
5. Automatically downloads document, formats SumatraPDF/PowerShell spooler arguments, spools to printer, and reports `COMPLETED`.

---

### B. Mock Mode (Development & Testing)
Runs simulated printing without physical printers:

```powershell
# Standard mock agent (simulates healthy 1-second print duration)
npm run agent:mock

# Failure simulation mode (simulates hardware paper jam and cloud retry backoff)
npm run agent:mock:fail
```

---

## 5. Print Command Specifications

### Method 1: SumatraPDF CLI Execution
SumatraPDF executes silent background printing with strict hardware flag control:
```powershell
SumatraPDF.exe -print-to "<PrinterName>" -print-settings "duplex,monochrome,1-5,2x,paper=A4" -silent "<filePath>"
```

| Flag | Values | Description |
| :--- | :--- | :--- |
| `duplex` / `simplex` | `duplex`, `simplex` | Double-sided vs single-sided printing |
| `color` / `monochrome` | `color`, `monochrome` | Full color vs black-and-white mode |
| `<page-range>` | `1-5, 8, 10-12` | Specific pages to print (omitted for all pages) |
| `<N>x` | `2x`, `3x`, `10x` | Repeat copy count (omitted for 1 copy) |
| `paper=<Size>` | `paper=A4`, `paper=Legal` | Target paper tray selection |

---

### Method 2: Native PowerShell Spooler Fallback
When SumatraPDF is omitted, the agent uses the native Windows Print Spooler:
```powershell
Start-Process -FilePath "<filePath>" -Verb PrintTo -ArgumentList "<PrinterName>" -PassThru | Wait-Process -Timeout 30
```

---

## 6. Hardware Discovery & Heartbeat Telemetry

The agent queries Windows WMI/CIM properties every 10 seconds:
```powershell
Get-CimInstance -ClassName Win32_Printer | Select-Object Name, Default, PortName, DriverName, PrinterStatus, CapabilityDescriptions, Capabilities
```

This telemetry is transmitted to the cloud backend at `/api/agent/heartbeat` and displayed live on the Admin Dashboard at `/admin/printers`.

---

## 7. Troubleshooting & Operator FAQ

| Issue | Cause | Resolution |
| :--- | :--- | :--- |
| **`401 / 403 Invalid agent token`** | `PRINTOS_AGENT_KEY` does not match the cloud database key | Verify the token in `.env.local` against the shop's agent registration. |
| **`Printer shows OFFLINE`** | USB cable disconnected or printer powered off | Check printer power and USB/LAN connection. Heartbeat will restore to `ONLINE` automatically. |
| **`SumatraPDF not found warning`** | SumatraPDF is not in default path or PATH | Install SumatraPDF from official site or specify `SUMATRA_PDF_PATH` in `.env.local`. |
| **`Paper Jam / Hardware Error`** | Physical printer error | Clear the jam; the agent will report `FAILED`, and the cloud will schedule a retry up to 3 attempts. |
