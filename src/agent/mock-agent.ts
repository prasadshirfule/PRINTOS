import { ClaimedJob, PrinterStatus } from '../types/printos';

export interface MockAgentConfig {
  apiUrl: string;
  apiKey: string;
  agentName: string;
  printerStatus: PrinterStatus;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  simulatedPrintDurationMs: number;
  mockFailure: boolean;
}

export class MockPrintAgent {
  private config: MockAgentConfig;
  private isRunning = false;
  private currentJob: ClaimedJob | null = null;

  constructor(customConfig?: Partial<MockAgentConfig>) {
    this.config = {
      apiUrl: process.env.PRINTOS_API_URL || 'http://localhost:3000',
      apiKey: process.env.PRINTOS_AGENT_KEY || 'mock-agent-secret-token',
      agentName: process.env.PRINTOS_AGENT_NAME || 'shop-pc-01',
      printerStatus: 'ONLINE',
      pollIntervalMs: Number(process.env.PRINT_AGENT_POLL_INTERVAL_MS) || 1500,
      heartbeatIntervalMs: 10000,
      simulatedPrintDurationMs: Number(process.env.PRINT_AGENT_SIMULATED_DURATION_MS) || 1000,
      mockFailure: process.env.PRINT_AGENT_MOCK_FAILURE === 'true',
      ...customConfig,
    };
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

  public async sendHeartbeat(): Promise<void> {
    try {
      await this.fetchApi('/api/agent/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          agentName: this.config.agentName,
          printerStatus: this.config.printerStatus,
          version: '1.0.0-mock',
          currentJobId: this.currentJob?.jobId || null,
          capabilities: {
            printer: 'Mock Shop Laser Printer',
            duplex: true,
            color: true,
            supportedPaper: ['A4', 'A5'],
          },
        }),
      });

    } catch (err: unknown) {
      console.error(`[MockAgent] Heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
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
      console.error(`[MockAgent] Claim job error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  public async updateJobStatus(jobId: string, status: 'PRINTING' | 'COMPLETED' | 'FAILED', errorMessage?: string) {
    return this.fetchApi(`/api/agent/jobs/${jobId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, errorMessage }),
    });
  }

  public async processJob(job: ClaimedJob): Promise<boolean> {
    this.currentJob = job;
    console.log(`\n------------------------------------------------------------`);
    console.log(`🖨️  [MockAgent] CLAIMED Job #${job.jobId} for Order #${job.orderNumber}`);
    console.log(`    File:       ${job.originalFilename}`);
    console.log(`    Options:    ${job.colorMode} | ${job.paperSize} | ${job.printSides}`);
    console.log(`    Copies:     ${job.copies}`);
    console.log(`    Pages:      ${job.pageSelection || 'All pages'}`);
    console.log(`------------------------------------------------------------`);

    // Report PRINTING status
    await this.updateJobStatus(job.jobId, 'PRINTING');
    console.log(`⏳ [MockAgent] Status: PRINTING (Simulating hardware spooling...)`);

    // Simulate printing duration
    await new Promise((resolve) => setTimeout(resolve, this.config.simulatedPrintDurationMs));

    if (this.config.mockFailure) {
      console.error(`❌ [MockAgent] Simulated failure triggered! Reporting FAILED.`);
      await this.updateJobStatus(job.jobId, 'FAILED', 'Simulated hardware paper jam');
      this.currentJob = null;
      return false;
    }

    // Report COMPLETED
    await this.updateJobStatus(job.jobId, 'COMPLETED');
    console.log(`✅ [MockAgent] Status: COMPLETED for Order #${job.orderNumber}`);
    this.currentJob = null;
    return true;
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
    console.log(`🟢 [MockAgent] Starting Mock Print Agent: ${this.config.agentName}`);
    console.log(`    Target API:   ${this.config.apiUrl}`);
    console.log(`    Failure Mode: ${this.config.mockFailure ? 'ENABLED (Failure Simulation)' : 'DISABLED (Normal)'}`);

    // Heartbeat ticker
    const heartbeatInterval = setInterval(() => {
      if (!this.isRunning) return;
      this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);

    // Initial heartbeat
    await this.sendHeartbeat();

    // Polling loop
    while (this.isRunning) {
      try {
        const processed = await this.runSingleCycle();
        if (!processed) {
          await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
        }
      } catch (err) {
        console.error('[MockAgent] Polling cycle error:', err);
        await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
      }
    }

    clearInterval(heartbeatInterval);
  }

  public stop(): void {
    this.isRunning = false;
    console.log(`🛑 [MockAgent] Stopped.`);
  }
}

// Standalone execution entry point
if (require.main === module) {
  const agent = new MockPrintAgent();
  agent.start().catch((err) => {
    console.error('Fatal agent error:', err);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    agent.stop();
    process.exit(0);
  });
}
