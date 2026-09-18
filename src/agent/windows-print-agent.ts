import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { ClaimedJob, PrinterStatus } from '../types/printos';

const execAsync = promisify(exec);

export interface DiscoveredPrinter {
  name: string;
  isDefault: boolean;
  portName?: string;
  driverName?: string;
  supportsColor: boolean;
  supportsDuplex: boolean;
  supportedPaperSizes: string[];
  status: PrinterStatus;
}

export interface WindowsAgentConfig {
  apiUrl: string;
  apiKey: string;
  agentName: string;
  preferredPrinter?: string;
  sumatraPdfPath?: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  tempSpoolDir: string;
}

export class WindowsPrinterDiscovery {
  /**
   * Discovers installed printers and their hardware capabilities using Windows WMI / PowerShell
   */
  public static async discoverPrinters(): Promise<DiscoveredPrinter[]> {
    if (process.platform !== 'win32') {
      // Fallback stub for non-Windows development environments
      return [
        {
          name: 'Default Virtual Printer',
          isDefault: true,
          supportsColor: true,
          supportsDuplex: true,
          supportedPaperSizes: ['A4', 'A3', 'Legal', 'Letter'],
          status: 'ONLINE',
        },
      ];
    }

    try {
      const psCommand = `
        Get-CimInstance -ClassName Win32_Printer | Select-Object Name, Default, PortName, DriverName, PrinterStatus, CapabilityDescriptions, Capabilities | ConvertTo-Json -Compress
      `.trim();

      const { stdout } = await execAsync(`powershell.exe -NoProfile -Command "${psCommand}"`);
      if (!stdout || !stdout.trim()) {
        return [];
      }

      const parsed = JSON.parse(stdout.trim());
      const printerList = Array.isArray(parsed) ? parsed : [parsed];

      return printerList.map((p) => {
        const name = p.Name || 'Unknown Printer';
        const isDefault = Boolean(p.Default);
        const caps = Array.isArray(p.CapabilityDescriptions)
          ? p.CapabilityDescriptions.join(' ').toLowerCase()
          : String(p.CapabilityDescriptions || '').toLowerCase();

        const supportsColor =
          caps.includes('color') ||
          (p.DriverName && p.DriverName.toLowerCase().includes('color')) ||
          true; // Default permissive

        const supportsDuplex =
          caps.includes('duplex') ||
          caps.includes('two-sided') ||
          (Array.isArray(p.Capabilities) && p.Capabilities.includes(3)); // 3 = Duplex in Win32_Printer

        const printerStatus: PrinterStatus =
          p.PrinterStatus === 3 || p.PrinterStatus === 0 ? 'ONLINE' : 'ONLINE';

        return {
          name,
          isDefault,
          portName: p.PortName,
          driverName: p.DriverName,
          supportsColor,
          supportsDuplex,
          supportedPaperSizes: ['A4', 'A3', 'Legal', 'Letter'],
          status: printerStatus,
        };
      });
    } catch (err) {
      console.warn('[WindowsPrintAgent] WMI Printer discovery fallback:', err);
      return [
        {
          name: 'Windows Default Printer',
          isDefault: true,
          supportsColor: true,
          supportsDuplex: true,
          supportedPaperSizes: ['A4', 'Legal'],
          status: 'ONLINE',
        },
      ];
    }
  }

  /**
   * Resolves the path to SumatraPDF executable
   */
  public static findSumatraPDF(customPath?: string): string | null {
    if (customPath && fs.existsSync(customPath)) {
      return customPath;
    }

    const candidatePaths = [
      process.env.SUMATRA_PDF_PATH,
      'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
      'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
      path.join(os.homedir(), 'AppData\\Local\\SumatraPDF\\SumatraPDF.exe'),
    ].filter(Boolean) as string[];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Check if in PATH
    try {
      execSync('where SumatraPDF.exe', { stdio: 'ignore' });
      return 'SumatraPDF.exe';
    } catch {
      return null;
    }
  }
}

export class WindowsPrintSpooler {
  /**
   * Formats SumatraPDF CLI print settings string
   * e.g., "duplex,monochrome,1-5,copies=2,paper=A4"
   */
  public static buildSumatraPrintSettings(job: ClaimedJob): string {
    const settings: string[] = [];

    // Duplex mode
    if (job.printSides === 'BOTH_SIDES') {
      settings.push('duplex');
    } else {
      settings.push('simplex');
    }

    // Color mode
    if (job.colorMode === 'COLOR') {
      settings.push('color');
    } else {
      settings.push('monochrome');
    }

    // Page selection
    if (job.pageSelection && job.pageSelection.toLowerCase() !== 'all') {
      settings.push(job.pageSelection);
    }

    // Copies
    if (job.copies && job.copies > 1) {
      settings.push(`copies=${job.copies}`);
    }

    // Paper size
    if (job.paperSize) {
      settings.push(`paper=${job.paperSize}`);
    }

    return settings.join(',');
  }

  /**
   * Spools document to Windows Print Subsystem via SumatraPDF or PowerShell
   */
  public static async printDocument(
    filePath: string,
    printerName: string,
    job: ClaimedJob,
    sumatraPath: string | null
  ): Promise<void> {
    if (sumatraPath) {
      const printSettings = this.buildSumatraPrintSettings(job);
      const command = `"${sumatraPath}" -print-to "${printerName}" -print-settings "${printSettings}" -silent "${filePath}"`;

      console.log(`[WindowsPrintSpooler] Executing SumatraPDF: ${command}`);
      const { stderr } = await execAsync(command, { timeout: 30000 });
      if (stderr && !stderr.toLowerCase().includes('warning')) {
        throw new Error(`SumatraPDF print warning/error: ${stderr}`);
      }
    } else {
      // Fallback to Native PowerShell Spooler
      console.log(`[WindowsPrintSpooler] SumatraPDF not found. Falling back to PowerShell Spooler for "${printerName}"`);
      const psScript = `
        Start-Process -FilePath "${filePath}" -Verb PrintTo -ArgumentList "${printerName}" -PassThru | Wait-Process -Timeout 30
      `.trim();

      await execAsync(`powershell.exe -NoProfile -Command "${psScript}"`, { timeout: 35000 });
    }
  }
}

export class WindowsPrintAgent {
  private config: WindowsAgentConfig;
  private isRunning = false;
  private currentJob: ClaimedJob | null = null;
  private discoveredPrinters: DiscoveredPrinter[] = [];
  private sumatraPdfPath: string | null = null;

  constructor(customConfig?: Partial<WindowsAgentConfig>) {
    this.config = {
      apiUrl: process.env.PRINTOS_API_URL || 'http://localhost:3000',
      apiKey: process.env.PRINTOS_AGENT_KEY || 'mock-agent-secret-token',
      agentName: process.env.PRINTOS_AGENT_NAME || `shop-pc-${os.hostname()}`,
      preferredPrinter: process.env.PRINT_AGENT_PRINTER_NAME,
      sumatraPdfPath: process.env.SUMATRA_PDF_PATH,
      pollIntervalMs: Number(process.env.PRINT_AGENT_POLL_INTERVAL_MS) || 1500,
      heartbeatIntervalMs: 10000,
      tempSpoolDir: path.join(os.tmpdir(), 'printos-agent-spool'),
      ...customConfig,
    };

    if (!fs.existsSync(this.config.tempSpoolDir)) {
      fs.mkdirSync(this.config.tempSpoolDir, { recursive: true });
    }
  }

  private async fetchApi(endpoint: string, options: RequestInit = {}) {
    const url = `${this.config.apiUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'x-agent-key': this.config.apiKey,
      ...options.headers,
    };

    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Agent API error [${res.status}] ${endpoint}: ${errText}`);
    }
    return res.json();
  }

  public async initialize(): Promise<void> {
    this.sumatraPdfPath = WindowsPrinterDiscovery.findSumatraPDF(this.config.sumatraPdfPath);
    this.discoveredPrinters = await WindowsPrinterDiscovery.discoverPrinters();

    console.log(`[WindowsPrintAgent] Initialized on host: ${os.hostname()} (${process.platform})`);
    console.log(`[WindowsPrintAgent] SumatraPDF Engine: ${this.sumatraPdfPath ? `AVAILABLE (${this.sumatraPdfPath})` : 'NOT FOUND (Using PowerShell fallback)'}`);
    console.log(`[WindowsPrintAgent] Discovered ${this.discoveredPrinters.length} printer(s):`);
    this.discoveredPrinters.forEach((p) => {
      console.log(`  • ${p.name} [Default: ${p.isDefault}, Color: ${p.supportsColor}, Duplex: ${p.supportsDuplex}]`);
    });
  }

  public async sendHeartbeat(): Promise<void> {
    try {
      const defaultPrinter =
        this.discoveredPrinters.find((p) => p.name === this.config.preferredPrinter) ||
        this.discoveredPrinters.find((p) => p.isDefault) ||
        this.discoveredPrinters[0];

      await this.fetchApi('/api/agent/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          agentName: this.config.agentName,
          printerStatus: defaultPrinter?.status || 'ONLINE',
          version: '1.0.0-windows',
          currentJobId: this.currentJob?.jobId || null,
          capabilities: {
            printerName: defaultPrinter?.name || 'Generic Windows Printer',
            supportsColor: defaultPrinter?.supportsColor ?? true,
            supportsDuplex: defaultPrinter?.supportsDuplex ?? true,
            supportedPaperSizes: defaultPrinter?.supportedPaperSizes || ['A4', 'A3', 'Legal'],
            engine: this.sumatraPdfPath ? 'SumatraPDF' : 'PowerShell-Spooler',
            installedPrinters: this.discoveredPrinters.map((p) => p.name),
          },
        }),
      });
    } catch (err: unknown) {
      console.error(`[WindowsPrintAgent] Heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public async claimNextJob(): Promise<ClaimedJob | null> {
    try {
      const data = await this.fetchApi('/api/agent/jobs/claim', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      return data.job || null;
    } catch (err: unknown) {
      console.error(`[WindowsPrintAgent] Claim error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  public async updateJobStatus(jobId: string, status: 'PRINTING' | 'COMPLETED' | 'FAILED', errorMessage?: string) {
    return this.fetchApi(`/api/agent/jobs/${jobId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, errorMessage }),
    });
  }

  public async downloadDocument(job: ClaimedJob): Promise<string> {
    const docEndpoint = `/api/agent/jobs/${job.jobId}/document`;
    const url = `${this.config.apiUrl}${docEndpoint}`;

    const res = await fetch(url, {
      headers: { 'x-agent-key': this.config.apiKey },
    });

    if (!res.ok) {
      throw new Error(`Failed to download document for job #${job.jobId} [${res.status}]`);
    }

    const contentType = res.headers.get('content-type') || '';
    let fileBuffer: Buffer;

    if (contentType.includes('application/json')) {
      const json = await res.json();
      if (json.downloadUrl) {
        // Download from presigned cloud storage URL
        const presignedRes = await fetch(json.downloadUrl);
        if (!presignedRes.ok) {
          throw new Error(`Presigned document download failed [${presignedRes.status}]`);
        }
        fileBuffer = Buffer.from(await presignedRes.arrayBuffer());
      } else {
        throw new Error('Missing downloadUrl in document response');
      }
    } else {
      fileBuffer = Buffer.from(await res.arrayBuffer());
    }

    const safeFilename = `${job.jobId}_${job.originalFilename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const localFilePath = path.join(this.config.tempSpoolDir, safeFilename);

    await fs.promises.writeFile(localFilePath, fileBuffer);
    return localFilePath;
  }

  public async processJob(job: ClaimedJob): Promise<boolean> {
    this.currentJob = job;
    let localFilePath: string | null = null;

    console.log(`\n============================================================`);
    console.log(`🖨️  [WindowsPrintAgent] CLAIMED Job #${job.jobId} for Order #${job.orderNumber}`);
    console.log(`    File:       ${job.originalFilename}`);
    console.log(`    Settings:   ${job.colorMode} | ${job.paperSize} | ${job.printSides} | Copies: ${job.copies}`);
    console.log(`    Pages:      ${job.pageSelection || 'all'}`);
    console.log(`============================================================`);

    try {
      // 1. Report PRINTING status
      await this.updateJobStatus(job.jobId, 'PRINTING');

      // 2. Download document to secure local temp spool
      localFilePath = await this.downloadDocument(job);

      // 3. Resolve target physical printer
      const targetPrinter =
        this.config.preferredPrinter ||
        this.discoveredPrinters.find((p) => p.isDefault)?.name ||
        this.discoveredPrinters[0]?.name ||
        'Default';

      // 4. Dispatch to Windows Spooler / SumatraPDF
      await WindowsPrintSpooler.printDocument(
        localFilePath,
        targetPrinter,
        job,
        this.sumatraPdfPath
      );

      // 5. Report COMPLETED
      await this.updateJobStatus(job.jobId, 'COMPLETED');
      console.log(`✅ [WindowsPrintAgent] Spooled successfully to "${targetPrinter}" (COMPLETED)`);
      return true;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`❌ [WindowsPrintAgent] Job #${job.jobId} failed:`, errorMsg);
      await this.updateJobStatus(job.jobId, 'FAILED', errorMsg);
      return false;
    } finally {
      // Clean up temporary document file from disk
      if (localFilePath && fs.existsSync(localFilePath)) {
        try {
          await fs.promises.unlink(localFilePath);
        } catch {
          // Ignore cleanup errors
        }
      }
      this.currentJob = null;
    }
  }

  public async runSingleCycle(): Promise<boolean> {
    await this.sendHeartbeat();
    const job = await this.claimNextJob();
    if (job) {
      return await this.processJob(job);
    }
    return false;
  }

  public async start(): Promise<void> {
    this.isRunning = true;
    await this.initialize();

    console.log(`🟢 [WindowsPrintAgent] Daemon started: ${this.config.agentName}`);
    console.log(`    API URL:      ${this.config.apiUrl}`);
    console.log(`    Spool Dir:    ${this.config.tempSpoolDir}`);

    const heartbeatInterval = setInterval(() => {
      if (!this.isRunning) return;
      this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);

    await this.sendHeartbeat();

    while (this.isRunning) {
      try {
        const processed = await this.runSingleCycle();
        if (!processed) {
          await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
        }
      } catch (err) {
        console.error('[WindowsPrintAgent] Polling cycle error:', err);
        await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
      }
    }

    clearInterval(heartbeatInterval);
  }

  public stop(): void {
    this.isRunning = false;
    console.log(`🛑 [WindowsPrintAgent] Stopped.`);
  }
}

// Standalone execution entry point
if (require.main === module) {
  const agent = new WindowsPrintAgent();
  agent.start().catch((err) => {
    console.error('Fatal Windows Print Agent error:', err);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    agent.stop();
    process.exit(0);
  });
}
