import crypto from 'crypto';
import {
  PrintOrder,
  PrintJob,
  PrintOrderEvent,
  Printer,
  PrintAgent,
  ClaimedJob,
  AgentJobStatusUpdate,
  OrderStatus,
  JobStatus,
  PrinterStatus,
} from '@/types/printos';
import { OrderStateMachine } from '@/lib/orders/state-machine';
import {
  IPrintOSRepository,
  DashboardMetrics,
  UnauthorizedAgentJobError,
  ResourceNotFoundError,
} from './repository.interface';

export class InMemoryPrintOSRepository implements IPrintOSRepository {
  private orders: Map<string, PrintOrder> = new Map();
  private jobs: Map<string, PrintJob> = new Map();
  private events: PrintOrderEvent[] = [];
  private printers: Map<string, Printer> = new Map();
  private agents: Map<string, PrintAgent> = new Map();
  private transactions: Set<string> = new Set();
  private claimLock = false;

  constructor() {
    this.seedDefaults();
  }

  private seedDefaults() {
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

    const mockAgent: PrintAgent = {
      id: '00000000-0000-0000-0000-000000000002',
      agentName: 'shop-pc-01',
      apiKeyHash: '9b66236b285b0d09a5b3a3c26b9a8cfefefb54cf21d2e1c4a035728a47401c10',
      status: 'ONLINE',
      version: '1.0.0',
      capabilities: { printer: 'Mock Shop Laser Printer', duplex: true, color: true },
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    this.agents.set(mockAgent.id, mockAgent);
  }

  public async createOrder(order: PrintOrder): Promise<PrintOrder> {
    if (this.orders.has(order.id)) {
      throw new Error(`Order with ID ${order.id} already exists.`);
    }
    this.orders.set(order.id, { ...order });
    await this.recordOrderEvent(order.id, 'FILE_RECEIVED', 'Order created and file registered', {
      filename: order.originalFilename,
      fileSize: order.fileSize,
      pageCount: order.pageCount,
    });
    return order;
  }

  public async getOrder(id: string): Promise<PrintOrder | null> {
    return this.orders.get(id) || null;
  }

  public async getOrderByNumber(orderNumber: string): Promise<PrintOrder | null> {
    for (const order of this.orders.values()) {
      if (order.orderNumber === orderNumber) return order;
    }
    return null;
  }

  public async listOrders(filters?: { status?: OrderStatus; limit?: number }): Promise<PrintOrder[]> {
    let list = Array.from(this.orders.values());
    if (filters?.status) {
      list = list.filter((o) => o.status === filters.status);
    }
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (filters?.limit) {
      list = list.slice(0, filters.limit);
    }
    return list;
  }

  public async updateOrderStatus(
    orderId: string,
    nextStatus: OrderStatus,
    metadata?: Record<string, unknown>
  ): Promise<PrintOrder> {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new ResourceNotFoundError('Order', orderId);
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
    await this.recordOrderEvent(
      orderId,
      `STATUS_CHANGE_${nextStatus}`,
      `Order status transitioned from ${prevStatus} to ${nextStatus}`,
      metadata
    );

    return order;
  }

  public async recordOrderEvent(
    orderId: string,
    eventType: string,
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<PrintOrderEvent> {
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

  public async getOrderEvents(orderId: string): Promise<PrintOrderEvent[]> {
    return this.events
      .filter((e) => e.orderId === orderId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  public async simulateVerifiedPayment(
    orderId: string,
    transactionId: string,
    provider = 'MOCK_UPI',
    amountPaisa?: number
  ): Promise<{ order: PrintOrder; job: PrintJob; isDuplicate: boolean }> {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new ResourceNotFoundError('Order', orderId);
    }

    // Compare gateway amount with order amount if provided
    if (amountPaisa !== undefined && amountPaisa !== order.totalAmountPaisa) {
      throw new Error(
        `Payment verification failed: Gateway amount (${amountPaisa} paisa) does not match order amount (${order.totalAmountPaisa} paisa).`
      );
    }

    const txKey = `${provider}:${transactionId}`;

    if (this.transactions.has(txKey) || order.paymentStatus === 'PAID') {
      const existingJob = await this.getJobByOrderId(orderId);
      if (!existingJob) {
        throw new Error('Order marked paid but print job missing.');
      }
      return { order, job: existingJob, isDuplicate: true };
    }

    this.transactions.add(txKey);

    await this.updateOrderStatus(orderId, 'PAID', { transactionId, provider });
    order.paymentStatus = 'PAID';
    order.paymentId = transactionId;

    await this.updateOrderStatus(orderId, 'QUEUED');

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

    await this.recordOrderEvent(orderId, 'PRINT_QUEUED', 'Print job added to printer queue', {
      jobId: job.id,
      printerId: job.printerId,
    });

    return { order, job, isDuplicate: false };
  }

  public async getJob(id: string): Promise<PrintJob | null> {
    return this.jobs.get(id) || null;
  }

  public async getJobByOrderId(orderId: string): Promise<PrintJob | null> {
    for (const job of this.jobs.values()) {
      if (job.orderId === orderId) return job;
    }
    return null;
  }

  public async listJobs(filters?: { status?: JobStatus; limit?: number }): Promise<PrintJob[]> {
    let list = Array.from(this.jobs.values());
    if (filters?.status) {
      list = list.filter((j) => j.status === filters.status);
    }
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (filters?.limit) {
      list = list.slice(0, filters.limit);
    }
    return list;
  }

  public async claimNextPrintJob(agentId: string, printerId?: string): Promise<ClaimedJob | null> {
    while (this.claimLock) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.claimLock = true;

    try {
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
        throw new ResourceNotFoundError('Order for claimed job', targetJob.orderId);
      }

      targetJob.status = 'CLAIMED';
      targetJob.agentId = agentId;
      targetJob.claimedAt = new Date().toISOString();
      targetJob.attemptCount += 1;
      this.jobs.set(targetJob.id, targetJob);

      await this.updateOrderStatus(order.id, 'PRINTING', {
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

  public async updateJobStatus(
    jobId: string,
    agentId: string,
    update: AgentJobStatusUpdate
  ): Promise<PrintJob> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new ResourceNotFoundError('Job', jobId);
    }

    // Strict Agent Authorization: Only claiming agent can update job
    if (job.agentId && job.agentId !== agentId) {
      throw new UnauthorizedAgentJobError(agentId, jobId);
    }

    const order = this.orders.get(job.orderId);
    const now = new Date().toISOString();

    if (update.status === 'PRINTING') {
      job.status = 'PRINTING';
      job.startedAt = now;
      if (order && order.status !== 'PRINTING') {
        await this.updateOrderStatus(order.id, 'PRINTING');
      }
    } else if (update.status === 'COMPLETED') {
      job.status = 'COMPLETED';
      job.completedAt = now;
      if (order) {
        await this.updateOrderStatus(order.id, 'COMPLETED', { completedAt: now });
      }
    } else if (update.status === 'FAILED') {
      job.errorMessage = update.errorMessage || 'Print failed';
      if (job.attemptCount < job.maxAttempts) {
        job.status = 'RETRY_PENDING';
        if (order) {
          await this.recordOrderEvent(
            order.id,
            'PRINT_RETRY_SCHEDULED',
            `Print attempt ${job.attemptCount} failed: ${job.errorMessage}. Re-queued for retry.`
          );
        }
      } else {
        job.status = 'FAILED';
        job.failedAt = now;
        if (order) {
          await this.updateOrderStatus(order.id, 'FAILED', { errorMessage: job.errorMessage });
        }
      }
    }

    this.jobs.set(jobId, job);
    return job;
  }

  public async authenticateAgent(providedKey: string): Promise<PrintAgent | null> {
    const hash = crypto.createHash('sha256').update(providedKey).digest('hex');
    for (const agent of this.agents.values()) {
      if (agent.apiKeyHash === hash) {
        return agent;
      }
    }
    return null;
  }

  public async recordAgentHeartbeat(
    agentName: string,
    printerStatus: PrinterStatus,
    capabilities?: Record<string, unknown>,
    version = '1.0.0'
  ): Promise<PrintAgent> {
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

    const printer = this.printers.get('00000000-0000-0000-0000-000000000001');
    if (printer) {
      printer.status = printerStatus;
      printer.lastSeenAt = now;
      this.printers.set(printer.id, printer);
    }

    return agent;
  }

  public async listPrinters(): Promise<Printer[]> {
    const now = Date.now();
    return Array.from(this.printers.values()).map((p) => {
      if (p.lastSeenAt && now - new Date(p.lastSeenAt).getTime() > 60000) {
        return { ...p, status: 'OFFLINE' };
      }
      return p;
    });
  }

  public async getDashboardMetrics(): Promise<DashboardMetrics> {
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

  public async clear(): Promise<void> {
    this.orders.clear();
    this.jobs.clear();
    this.events = [];
    this.transactions.clear();
    this.seedDefaults();
  }
}