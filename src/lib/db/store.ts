import {
  OrderStatus,
  JobStatus,
  PrintOrder,
  PrintJob,
  PrintOrderEvent,
  Printer,
  PrintAgent,
  ClaimedJob,
  AgentJobStatusUpdate,
} from '@/types/printos';
import { OrderStateMachine } from '@/lib/orders/state-machine';

/**
 * High-performance, transaction-safe domain store for PRINTOS.
 * Designed to back both the Supabase integration and standalone local operations.
 * Implements strict atomic job claiming, idempotent payment handling,
 * and order state machine validation.
 */
class PrintosDataStore {
  private orders: Map<string, PrintOrder> = new Map();
  private jobs: Map<string, PrintJob> = new Map();
  private events: PrintOrderEvent[] = [];
  private printers: Map<string, Printer> = new Map();
  private agents: Map<string, PrintAgent> = new Map();
  private transactions: Set<string> = new Set(); // (provider:txId)
  private claimLock = false; // Mutex for atomic job claiming

  constructor() {
    this.seedDefaults();
  }

  private seedDefaults() {
    // Seed default Mock Printer
    const mockPrinter: Printer = {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Mock Shop Laser Printer',
      location: 'Front Counter',
      status: 'ONLINE',
      isActive: true,
      supportsColor: true,
      supportsDuplex: true,
      supportedPaperSizes: ['A4', 'A5'],
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    this.printers.set(mockPrinter.id, mockPrinter);

    // Seed default Mock Agent
    const mockAgent: PrintAgent = {
      id: '00000000-0000-0000-0000-000000000002',
      agentName: 'shop-pc-01',
      // sha256 of 'mock-agent-secret-token'
      apiKeyHash: '9b66236b285b0d09a5b3a3c26b9a8cfefefb54cf21d2e1c4a035728a47401c10',
      status: 'ONLINE',
      version: '1.0.0',
      capabilities: { printer: 'Mock Shop Laser Printer', duplex: true, color: true },
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    this.agents.set(mockAgent.id, mockAgent);
  }

  // --------------------------------------------------------------------------
  // ORDER MANAGEMENT
  // --------------------------------------------------------------------------

  public createOrder(order: PrintOrder): PrintOrder {
    if (this.orders.has(order.id)) {
      throw new Error(`Order with ID ${order.id} already exists.`);
    }
    this.orders.set(order.id, { ...order });
    this.recordEvent(order.id, 'FILE_RECEIVED', 'Order created and file registered', {
      filename: order.originalFilename,
      fileSize: order.fileSize,
      pageCount: order.pageCount,
    });
    return order;
  }

  public getOrder(id: string): PrintOrder | null {
    return this.orders.get(id) || null;
  }

  public getOrderByNumber(orderNumber: string): PrintOrder | null {
    for (const order of this.orders.values()) {
      if (order.orderNumber === orderNumber) return order;
    }
    return null;
  }

  public listOrders(): PrintOrder[] {
    return Array.from(this.orders.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  public updateOrderStatus(
    orderId: string,
    nextStatus: OrderStatus,
    metadata?: Record<string, unknown>
  ): PrintOrder {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found.`);
    }

    OrderStateMachine.validateTransition(order.status, nextStatus);

    const prevStatus = order.status;
    order.status = nextStatus;

    const now = new Date().toISOString();
    if (nextStatus === 'PAID') order.paidAt = now;
    if (nextStatus === 'QUEUED') order.queuedAt = now;
    if (nextStatus === 'PRINTING' && !order.startedAt) order.startedAt = now;
    if (nextStatus === 'COMPLETED') order.completedAt = now;
    if (nextStatus === 'FAILED') order.failedAt = now;

    this.orders.set(orderId, order);
    this.recordEvent(
      orderId,
      `STATUS_CHANGE_${nextStatus}`,
      `Order status transitioned from ${prevStatus} to ${nextStatus}`,
      metadata
    );

    return order;
  }

  public recordEvent(
    orderId: string,
    eventType: string,
    message: string,
    metadata?: Record<string, unknown>
  ): PrintOrderEvent {
    const event: PrintOrderEvent = {
      id: crypto.randomUUID(),
      orderId,
      eventType,
      message,
      metadata,
      createdAt: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }

  public getOrderEvents(orderId: string): PrintOrderEvent[] {
    return this.events
      .filter((e) => e.orderId === orderId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  // --------------------------------------------------------------------------
  // PAYMENT & PRINT JOB IDEMPOTENCY
  // --------------------------------------------------------------------------

  public simulateVerifiedPayment(
    orderId: string,
    transactionId: string,
    provider = 'MOCK_UPI'
  ): { order: PrintOrder; job: PrintJob; isDuplicate: boolean } {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found.`);
    }

    const txKey = `${provider}:${transactionId}`;

    // Idempotency check: has this transaction or order already been paid?
    if (this.transactions.has(txKey) || order.paymentStatus === 'PAID') {
      // Return existing order and job without re-queueing
      const existingJob = this.getJobByOrderId(orderId);
      if (!existingJob) {
        throw new Error('Order marked paid but print job missing.');
      }
      return { order, job: existingJob, isDuplicate: true };
    }

    this.transactions.add(txKey);

    // Transition order to PAID
    this.updateOrderStatus(orderId, 'PAID', { transactionId, provider });
    order.paymentStatus = 'PAID';
    order.paymentId = transactionId;

    // Transition order to QUEUED
    this.updateOrderStatus(orderId, 'QUEUED');

    // Create exactly ONE print job (enforced by order uniqueness)
    const job: PrintJob = {
      id: crypto.randomUUID(),
      orderId: order.id,
      printerId: order.printerId || '00000000-0000-0000-0000-000000000001',
      agentId: null,
      status: 'QUEUED',
      priority: 10,
      attemptCount: 0,
      maxAttempts: 3,
      documentUrl: `/api/agent/jobs/${order.id}/document`,
      printOptions: {
        copies: order.copies,
        paperSize: order.paperSize,
        colorMode: order.colorMode,
        printSides: order.printSides,
        pageSelection: order.pageSelection,
      },
      createdAt: new Date().toISOString(),
    };

    this.jobs.set(job.id, job);

    this.recordEvent(orderId, 'PRINT_QUEUED', 'Print job added to printer queue', {
      jobId: job.id,
      printerId: job.printerId,
    });

    return { order, job, isDuplicate: false };
  }

  // --------------------------------------------------------------------------
  // ATOMIC QUEUE CLAIMING & MANAGEMENT
  // --------------------------------------------------------------------------

  public getJobByOrderId(orderId: string): PrintJob | null {
    for (const job of this.jobs.values()) {
      if (job.orderId === orderId) return job;
    }
    return null;
  }

  public getJob(id: string): PrintJob | null {
    return this.jobs.get(id) || null;
  }

  public listJobs(): PrintJob[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * Atomically claims the next eligible print job.
   * Simulates the PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` atomic guarantee.
   */
  public async claimNextPrintJob(agentId: string, printerId?: string): Promise<ClaimedJob | null> {
    // Acquire mutex lock
    while (this.claimLock) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.claimLock = true;

    try {
      // Find highest priority queued job
      const eligibleJobs = Array.from(this.jobs.values())
        .filter(
          (j) =>
            (j.status === 'QUEUED' || j.status === 'RETRY_PENDING') &&
            (!printerId || j.printerId === printerId || !j.printerId)
        )
        .sort((a, b) => b.priority - a.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      if (eligibleJobs.length === 0) {
        return null;
      }

      const targetJob = eligibleJobs[0];
      const order = this.orders.get(targetJob.orderId);
      if (!order) {
        throw new Error(`Order ${targetJob.orderId} associated with job ${targetJob.id} not found.`);
      }

      // Transition job to CLAIMED
      targetJob.status = 'CLAIMED';
      targetJob.agentId = agentId;
      targetJob.claimedAt = new Date().toISOString();
      targetJob.attemptCount += 1;
      this.jobs.set(targetJob.id, targetJob);

      // Transition order to PRINTING
      this.updateOrderStatus(order.id, 'PRINTING', {
        jobId: targetJob.id,
        agentId,
        attempt: targetJob.attemptCount,
      });

      return {
        jobId: targetJob.id,
        orderId: order.id,
        orderNumber: order.orderNumber,
        storagePath: order.storagePath,
        originalFilename: order.originalFilename,
        printOptions: targetJob.printOptions,
        copies: order.copies,
        paperSize: order.paperSize,
        colorMode: order.colorMode,
        printSides: order.printSides,
        pageSelection: order.pageSelection,
        downloadUrl: `/api/agent/jobs/${targetJob.id}/document`,
      };
    } finally {
      this.claimLock = false;
    }
  }

  public updateJobStatus(jobId: string, update: AgentJobStatusUpdate): PrintJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found.`);
    }

    const order = this.orders.get(job.orderId);
    const now = new Date().toISOString();

    if (update.status === 'PRINTING') {
      job.status = 'PRINTING';
      job.startedAt = now;
      if (order && order.status !== 'PRINTING') {
        this.updateOrderStatus(order.id, 'PRINTING');
      }
    } else if (update.status === 'COMPLETED') {
      job.status = 'COMPLETED';
      job.completedAt = now;
      if (order) {
        this.updateOrderStatus(order.id, 'COMPLETED', { completedAt: now });
      }
    } else if (update.status === 'FAILED') {
      job.errorMessage = update.errorMessage || 'Print failed';
      if (job.attemptCount < job.maxAttempts) {
        // Safe retry logic
        job.status = 'RETRY_PENDING';
        if (order) {
          this.recordEvent(order.id, 'PRINT_RETRY_SCHEDULED', `Print attempt ${job.attemptCount} failed: ${job.errorMessage}. Re-queued for retry.`);
        }
      } else {
        job.status = 'FAILED';
        job.failedAt = now;
        if (order) {
          this.updateOrderStatus(order.id, 'FAILED', { errorMessage: job.errorMessage });
        }
      }
    }

    this.jobs.set(jobId, job);
    return job;
  }

  // --------------------------------------------------------------------------
  // AGENT & PRINTER MONITORING
  // --------------------------------------------------------------------------

  public authenticateAgent(providedKey: string): PrintAgent | null {
    // In dev / test, accept 'mock-agent-secret-token'
    for (const agent of this.agents.values()) {
      if (
        providedKey === 'mock-agent-secret-token' ||
        agent.apiKeyHash === providedKey
      ) {
        return agent;
      }
    }
    return null;
  }

  public recordAgentHeartbeat(
    agentName: string,
    printerStatus: Printer['status'],
    capabilities?: Record<string, unknown>,
    version = '1.0.0'
  ): PrintAgent {
    let agent: PrintAgent | undefined;
    for (const a of this.agents.values()) {
      if (a.agentName === agentName) {
        agent = a;
        break;
      }
    }

    const now = new Date().toISOString();
    if (!agent) {
      agent = {
        id: crypto.randomUUID(),
        agentName,
        apiKeyHash: '9b66236b285b0d09a5b3a3c26b9a8cfefefb54cf21d2e1c4a035728a47401c10',
        status: 'ONLINE',
        version,
        capabilities: capabilities || {},
        lastSeenAt: now,
        createdAt: now,
      };
      this.agents.set(agent.id, agent);
    } else {
      agent.status = 'ONLINE';
      agent.lastSeenAt = now;
      agent.version = version;
      if (capabilities) agent.capabilities = capabilities;
      this.agents.set(agent.id, agent);
    }

    // Update associated printer status
    const printer = this.printers.get('00000000-0000-0000-0000-000000000001');
    if (printer) {
      printer.status = printerStatus;
      printer.lastSeenAt = now;
      this.printers.set(printer.id, printer);
    }

    return agent;
  }

  public listPrinters(): Printer[] {
    // Mark printer offline if no heartbeat in last 60 seconds
    const now = Date.now();
    return Array.from(this.printers.values()).map((p) => {
      if (p.lastSeenAt && now - new Date(p.lastSeenAt).getTime() > 60000) {
        return { ...p, status: 'OFFLINE' };
      }
      return p;
    });
  }

  public getDashboardMetrics() {
    const allOrders = Array.from(this.orders.values());
    const queuedCount = allOrders.filter((o) => o.status === 'QUEUED').length;
    const printingCount = allOrders.filter((o) => o.status === 'PRINTING').length;
    const completedCount = allOrders.filter((o) => o.status === 'COMPLETED').length;
    const failedCount = allOrders.filter((o) => o.status === 'FAILED').length;
    const totalRevenuePaisa = allOrders
      .filter((o) => o.paymentStatus === 'PAID')
      .reduce((sum, o) => sum + o.totalAmountPaisa, 0);
    const totalPagesPrinted = allOrders
      .filter((o) => o.status === 'COMPLETED')
      .reduce((sum, o) => sum + o.selectedPageCount * o.copies, 0);

    return {
      todayOrders: allOrders.length,
      queued: queuedCount,
      printing: printingCount,
      completed: completedCount,
      failed: failedCount,
      revenuePaisa: totalRevenuePaisa,
      pagesPrinted: totalPagesPrinted,
    };
  }

  public clear() {
    this.orders.clear();
    this.jobs.clear();
    this.events = [];
    this.transactions.clear();
    this.seedDefaults();
  }
}

// Global singleton instance for runtime and API routes
export const globalStore = new PrintosDataStore();
