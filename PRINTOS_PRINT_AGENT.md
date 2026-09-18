# PRINTOS — Print Agent Specification & Execution Guide

---

## 1. Print Agent Architecture

To ensure physical shop security and cloud reliability:
**The cloud server NEVER directly touches the physical USB or LAN printer.**

Instead, the local shop PC runs the isolated **Print Agent daemon**:
```
Cloud Backend API (/api/agent/*)
         ▲
         │ (Outbound HTTPS polling & heartbeats)
         │
   Print Agent (Local Shop PC)
         │
         ▼
Windows Print Subsystem (Spooler API / PowerShell / SumatraPDF CLI)
         │
         ▼
Physical Printer (USB / Wi-Fi)
```

### Key Architectural Rules
1. The Print Agent never holds administrative database credentials or service-role keys.
2. The agent authenticates using an agent API token via the `x-agent-key` header.
3. Queue claiming is atomic: executed by the cloud backend using `FOR UPDATE SKIP LOCKED`.
4. The cloud backend issues short-lived presigned URLs for document download; documents are never public.

---

## 2. Agent Execution Modes

### A. Mock Mode (Phase 1 Ready)
Used for automated local development and testing without physical printers.
- Authenticates with cloud backend.
- Reports status: `ONLINE`.
- Sends heartbeats every 10 seconds.
- Atomically claims pending jobs from the queue.
- Simulates hardware printing delay (configurable, default 1s).
- Reports status: `PRINTING` ➔ `COMPLETED`.

To run:
```powershell
npm run agent:mock
```

### B. Mock Failure Simulation Mode
Tests paper jam, out-of-paper, and hardware failure handling with controlled retries.
```powershell
npm run agent:mock:fail
```
Behavior:
1. Agent claims job #1.
2. Reports `PRINTING`.
3. Simulates hardware failure and reports `FAILED`.
4. Cloud backend schedules job for retry (`attemptCount = 1`, status `RETRY_PENDING`).
5. Upon reaching `maxAttempts = 3`, the job and order transition to permanent `FAILED`.

---

## 3. Connecting a Real Physical Windows Printer (Phase 4 Specification)

For production Windows deployment, the print agent will execute native Windows printing commands:

### Method 1: SumatraPDF CLI (Recommended for PDFs)
SumatraPDF provides silent printing with strict duplex, color, and page range flags:
```powershell
SumatraPDF.exe -print-to "<PrinterName>" -print-settings "duplex,color,1-5" "downloaded_job.pdf"
```

### Method 2: Native PowerShell Spooler API
```powershell
Start-Process -FilePath "document.pdf" -Verb PrintTo -ArgumentList "<PrinterName>" -PassThru | Wait-Process
```

### Native Capability Discovery
The Windows agent queries hardware capabilities using WMI / CIM:
```powershell
Get-CimInstance -ClassName Win32_Printer | Select-Object Name, Default, PortName, PrinterStatus, CapabilityDescriptions
```
These capabilities (`supportsColor`, `supportsDuplex`, `supportedPaperSizes`) are transmitted in the periodic agent heartbeat.
