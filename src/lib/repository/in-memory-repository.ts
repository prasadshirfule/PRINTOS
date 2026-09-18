import crypto from 'crypto';
import {
  Shop,
  DEFAULT_SHOP_ID,
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
import {
  ConversationState,
  ConversationSessionData,
  WhatsAppConversation,
  WhatsAppInboxItem,
  WhatsAppOutboxItem,
  WhatsAppOutboxPayload,
  WhatsAppMessage,
  OutboxMessageType,
} from '@/types/whatsapp';
import { OrderStateMachine } from '@/lib/orders/state-machine';
import {
  IPrintOSRepository,
  DashboardMetrics,
  UnauthorizedAgentJobError,
  ResourceNotFoundError,
  StaleConversationVersionError,
} from './repository.interface';

export class InMemoryPrintOSRepository implements IPrintOSRepository {
  private shops: Map<string, Shop> = new Map();
  private orders: Map<string, PrintOrder> = new Map();
  private jobs: Map<string, PrintJob> = new Map();
  private events: PrintOrderEvent[] = [];
  private printers: Map<string, Printer> = new Map();
  private agents: Map<string, PrintAgent> = new Map();
  private transactions: Set<string> = new Set();
  private conversations: Map<string, WhatsAppConversation> = new Map();
  private inbox: Map<string, WhatsAppInboxItem> = new Map();
  private outbox: Map<string, WhatsAppOutboxItem> = new Map();
  private whatsappMessages: WhatsAppMessage[] = [];
  private storedDocuments: Set<string> = new Set();
  private claimLock = false;

  constructor() {
    this.seedDefaults();
  }

  private seedDefaults() {
    const defaultShop: Shop = {
      id: DEFAULT_SHOP_ID,
      name: 'PRINTOS Flagship Shop',
      slug: 'main-shop',
      phone: '+919999999999',
      address: 'Shop No. 1, Front Counter Hub',
      currency: 'INR',
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.shops.set(defaultShop.id, defaultShop);

    const mockPrinter: Printer = {
      id: '00000000-0000-0000-0000-000000000001',
      shopId: DEFAULT_SHOP_ID,
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
      shopId: DEFAULT_SHOP_ID,
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

  // --------------------------------------------------------------------------
  // Shop Tenant Management
  // --------------------------------------------------------------------------
  public async getShop(shopId: string): Promise<Shop | null> {
    return this.shops.get(shopId) || null;
  }

  public async listShops(): Promise<Shop[]> {
    return Array.from(this.shops.values());
  }

  public async createShop(shop: Shop): Promise<Shop> {
    if (this.shops.has(shop.id)) {
      throw new Error(`Shop with ID ${shop.id} already exists.`);
    }
    this.shops.set(shop.id, { ...shop });
    return shop;
  }

  // --------------------------------------------------------------------------
  // Order Operations
  // --------------------------------------------------------------------------
  public async createOrder(order: PrintOrder): Promise<PrintOrder> {
    if (this.orders.has(order.id)) {
      throw new Error(`Order with ID ${order.id} already exists.`);
    }
    const orderWithShop: PrintOrder = {
      ...order,
      shopId: order.shopId || DEFAULT_SHOP_ID,
    };
    this.orders.set(order.id, orderWithShop);
    await this.recordOrderEvent(order.id, 'FILE_RECEIVED', 'Order created and file registered', {
      filename: order.originalFilename,
      fileSize: order.fileSize,
      pageCount: order.pageCount,
      shopId: orderWithShop.shopId,
    });
    return orderWithShop;
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

  public async listOrders(filters?: { status?: OrderStatus; limit?: number; shopId?: string }): Promise<PrintOrder[]> {
    let list = Array.from(this.orders.values());
    if (filters?.shopId) {
      list = list.filter((o) => o.shopId === filters.shopId);
    }
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

    const now = new Date().toISOString();
    order.status = nextStatus;

    if (nextStatus === 'PAID') order.paidAt = now;
    if (nextStatus === 'QUEUED') order.queuedAt = now;
    if (nextStatus === 'PRINTING') order.startedAt = now;
    if (nextStatus === 'COMPLETED') order.completedAt = now;
    if (nextStatus === 'FAILED' || nextStatus === 'CANCELLED') order.failedAt = now;

    this.orders.set(orderId, order);

    await this.recordOrderEvent(orderId, `STATUS_${nextStatus}`, `Order transitioned to ${nextStatus}`, metadata);

    return order;
  }

  // --------------------------------------------------------------------------
  // Audit Events
  // --------------------------------------------------------------------------
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
      metadata: metadata || {},
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

  // --------------------------------------------------------------------------
  // Payment & Idempotency
  // --------------------------------------------------------------------------
  public async simulateVerifiedPayment(
    orderId: string,
    transactionId: string,
    provider = 'UPI_QR',
    amountPaisa?: number
  ): Promise<{ order: PrintOrder; job: PrintJob; isDuplicate: boolean }> {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new ResourceNotFoundError('Order', orderId);
    }

    const txKey = `${provider}:${transactionId}`;

    if (this.transactions.has(txKey)) {
      const existingJob = await this.getJobByOrderId(orderId);
      if (existingJob) {
        return { order, job: existingJob, isDuplicate: true };
      }
    }

    if (amountPaisa !== undefined && amountPaisa !== order.totalAmountPaisa) {
      throw new Error(
        `Payment amount mismatch: expected ${order.totalAmountPaisa} paisa, received ${amountPaisa} paisa`
      );
    }

    this.transactions.add(txKey);

    await this.updateOrderStatus(orderId, 'PAID', { transactionId, provider });
    order.paymentStatus = 'PAID';
    order.paymentId = transactionId;

    await this.updateOrderStatus(orderId, 'QUEUED');

    const job: PrintJob = {
      id: crypto.randomUUID(),
      shopId: order.shopId || DEFAULT_SHOP_ID,
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
      shopId: job.shopId,
    });

    return { order, job, isDuplicate: false };
  }

  // --------------------------------------------------------------------------
  // Print Jobs & Atomic Queue Claiming
  // --------------------------------------------------------------------------
  public async getJob(id: string): Promise<PrintJob | null> {
    return this.jobs.get(id) || null;
  }

  public async getJobByOrderId(orderId: string): Promise<PrintJob | null> {
    for (const job of this.jobs.values()) {
      if (job.orderId === orderId) return job;
    }
    return null;
  }

  public async listJobs(filters?: { status?: JobStatus; limit?: number; shopId?: string }): Promise<PrintJob[]> {
    let list = Array.from(this.jobs.values());
    if (filters?.shopId) {
      list = list.filter((j) => j.shopId === filters.shopId);
    }
    if (filters?.status) {
      list = list.filter((j) => j.status === filters.status);
    }
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (filters?.limit) {
      list = list.slice(0, filters.limit);
    }
    return list;
  }

  public async claimNextPrintJob(agentId: string, printerId?: string, shopId?: string): Promise<ClaimedJob | null> {
    while (this.claimLock) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.claimLock = true;

    try {
      const agent = this.agents.get(agentId);
      const targetShopId = shopId || agent?.shopId;

      const eligibleJobs = Array.from(this.jobs.values())
        .filter(
          (j) =>
            (j.status === 'QUEUED' || j.status === 'RETRY_PENDING') &&
            (!targetShopId || j.shopId === targetShopId || !j.shopId) &&
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
        shopId: targetJob.shopId,
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
        shopId: DEFAULT_SHOP_ID,
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

  public async listPrinters(filters?: { shopId?: string }): Promise<Printer[]> {
    const now = Date.now();
    let list = Array.from(this.printers.values());
    if (filters?.shopId) {
      list = list.filter((p) => p.shopId === filters.shopId);
    }
    return list.map((p) => {
      if (p.lastSeenAt && now - new Date(p.lastSeenAt).getTime() > 60000) {
        return { ...p, status: 'OFFLINE' };
      }
      return p;
    });
  }

  public async getDashboardMetrics(shopId?: string): Promise<DashboardMetrics> {
    let allOrders = Array.from(this.orders.values());
    if (shopId) {
      allOrders = allOrders.filter((o) => o.shopId === shopId);
    }
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

  // --------------------------------------------------------------------------
  // Phase 2: WhatsApp Conversations & Locking
  // --------------------------------------------------------------------------
  public async getConversation(customerPhone: string, shopId?: string): Promise<WhatsAppConversation | null> {
    const conv = this.conversations.get(customerPhone);
    if (!conv) return null;
    if (shopId && conv.shopId && conv.shopId !== shopId) return null;
    return conv;
  }

  public async upsertConversation(
    conversation: Partial<WhatsAppConversation> & { customerPhone: string; shopId?: string | null }
  ): Promise<WhatsAppConversation> {
    const existing = this.conversations.get(conversation.customerPhone);
    const now = new Date().toISOString();

    if (existing) {
      const updated: WhatsAppConversation = {
        ...existing,
        shopId: conversation.shopId || existing.shopId || DEFAULT_SHOP_ID,
        customerName: conversation.customerName !== undefined ? conversation.customerName : existing.customerName,
        currentState: conversation.currentState || existing.currentState,
        activeOrderId: conversation.activeOrderId !== undefined ? conversation.activeOrderId : existing.activeOrderId,
        sessionData: conversation.sessionData ? { ...existing.sessionData, ...conversation.sessionData } : existing.sessionData,
        version: existing.version + 1,
        lastInteractionAt: now,
        updatedAt: now,
      };
      this.conversations.set(conversation.customerPhone, updated);
      return updated;
    }

    const created: WhatsAppConversation = {
      id: conversation.id || crypto.randomUUID(),
      shopId: conversation.shopId || DEFAULT_SHOP_ID,
      customerPhone: conversation.customerPhone,
      customerName: conversation.customerName || null,
      currentState: conversation.currentState || 'IDLE',
      activeOrderId: conversation.activeOrderId || null,
      sessionData: conversation.sessionData || {},
      version: 1,
      lastInteractionAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversation.customerPhone, created);
    return created;
  }

  public async updateConversationState(
    customerPhone: string,
    nextState: ConversationState,
    sessionData?: ConversationSessionData,
    activeOrderId?: string | null,
    expectedVersion?: number,
    shopId?: string
  ): Promise<WhatsAppConversation> {
    const conversation = this.conversations.get(customerPhone);
    if (!conversation) {
      throw new ResourceNotFoundError('Conversation', customerPhone);
    }

    if (shopId && conversation.shopId && conversation.shopId !== shopId) {
      throw new ResourceNotFoundError('Conversation for tenant shop', customerPhone);
    }

    if (expectedVersion !== undefined && conversation.version !== expectedVersion) {
      throw new StaleConversationVersionError(customerPhone, expectedVersion);
    }

    const now = new Date().toISOString();
    const updated: WhatsAppConversation = {
      ...conversation,
      currentState: nextState,
      sessionData: sessionData !== undefined ? sessionData : conversation.sessionData,
      activeOrderId: activeOrderId !== undefined ? activeOrderId : conversation.activeOrderId,
      version: conversation.version + 1,
      lastInteractionAt: now,
      updatedAt: now,
    };

    this.conversations.set(customerPhone, updated);
    return updated;
  }

  // --------------------------------------------------------------------------
  // Phase 2: WhatsApp Inbox Operations
  // --------------------------------------------------------------------------
  public async enqueueInboxItem(item: {
    messageId: string;
    senderPhone: string;
    rawPayload: Record<string, unknown>;
    shopId?: string;
  }): Promise<{ item: WhatsAppInboxItem; isDuplicate: boolean }> {
    for (const existing of this.inbox.values()) {
      if (existing.messageId === item.messageId) {
        return { item: existing, isDuplicate: true };
      }
    }

    const now = new Date().toISOString();
    const inboxItem: WhatsAppInboxItem = {
      id: crypto.randomUUID(),
      shopId: item.shopId || DEFAULT_SHOP_ID,
      messageId: item.messageId,
      senderPhone: item.senderPhone,
      rawPayload: item.rawPayload,
      status: 'RECEIVED',
      workerId: null,
      lockedUntil: null,
      processingStartedAt: null,
      attemptCount: 0,
      maxAttempts: 5,
      lastError: null,
      receivedAt: now,
      processedAt: null,
    };

    this.inbox.set(inboxItem.id, inboxItem);
    return { item: inboxItem, isDuplicate: false };
  }

  public async claimInboxBatch(
    workerId: string,
    limit = 10,
    leaseSeconds = 120
  ): Promise<WhatsAppInboxItem[]> {
    const nowTime = Date.now();
    const claimed: WhatsAppInboxItem[] = [];

    const eligible = Array.from(this.inbox.values())
      .filter((i) => {
        if (i.status === 'RECEIVED' || i.status === 'RETRYABLE') return true;
        if (i.status === 'PROCESSING' && i.lockedUntil && new Date(i.lockedUntil).getTime() < nowTime) {
          return true; // Expired lease
        }
        return false;
      })
      .sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime())
      .slice(0, limit);

    for (const item of eligible) {
      const lockedUntil = new Date(nowTime + leaseSeconds * 1000).toISOString();
      const updated: WhatsAppInboxItem = {
        ...item,
        status: 'PROCESSING',
        workerId,
        processingStartedAt: new Date(nowTime).toISOString(),
        lockedUntil,
      };
      this.inbox.set(item.id, updated);
      claimed.push(updated);
    }

    return claimed;
  }

  public async renewInboxLease(id: string, workerId: string, additionalSeconds = 120): Promise<boolean> {
    const item = this.inbox.get(id);
    if (!item) return false;
    const nowTime = Date.now();

    if (item.workerId !== workerId || !item.lockedUntil || new Date(item.lockedUntil).getTime() < nowTime) {
      return false;
    }

    item.lockedUntil = new Date(nowTime + additionalSeconds * 1000).toISOString();
    this.inbox.set(id, item);
    return true;
  }

  public async completeInboxItem(id: string, workerId: string): Promise<boolean> {
    const item = this.inbox.get(id);
    if (!item) return false;
    const nowTime = Date.now();

    if (item.workerId !== workerId || (item.lockedUntil && new Date(item.lockedUntil).getTime() < nowTime)) {
      return false;
    }

    item.status = 'PROCESSED';
    item.processedAt = new Date().toISOString();
    item.lockedUntil = null;
    this.inbox.set(id, item);
    return true;
  }

  public async failInboxItem(
    id: string,
    workerId: string,
    error: string,
    retryable = true
  ): Promise<boolean> {
    const item = this.inbox.get(id);
    if (!item) return false;

    if (item.workerId !== workerId) return false;

    item.attemptCount += 1;
    item.lastError = error;
    item.lockedUntil = null;

    if (!retryable || item.attemptCount >= item.maxAttempts) {
      item.status = 'DEAD_LETTER';
    } else {
      item.status = 'RETRYABLE';
    }

    this.inbox.set(id, item);
    return true;
  }

  // --------------------------------------------------------------------------
  // Phase 2: WhatsApp Outbox Operations
  // --------------------------------------------------------------------------
  public async enqueueOutboxItem(item: {
    conversationId?: string | null;
    orderId?: string | null;
    recipientPhone: string;
    messageType: OutboxMessageType;
    payload: WhatsAppOutboxPayload;
    shopId?: string;
  }): Promise<WhatsAppOutboxItem> {
    const now = new Date().toISOString();
    const outboxItem: WhatsAppOutboxItem = {
      id: crypto.randomUUID(),
      shopId: item.shopId || DEFAULT_SHOP_ID,
      conversationId: item.conversationId || null,
      orderId: item.orderId || null,
      recipientPhone: item.recipientPhone,
      messageType: item.messageType,
      payload: item.payload,
      status: 'PENDING',
      workerId: null,
      lockedUntil: null,
      attemptCount: 0,
      maxAttempts: 5,
      nextAttemptAt: now,
      providerMessageId: null,
      lastError: null,
      createdAt: now,
      sentAt: null,
    };

    this.outbox.set(outboxItem.id, outboxItem);
    return outboxItem;
  }

  public async claimOutboxBatch(
    workerId: string,
    limit = 10,
    leaseSeconds = 120
  ): Promise<WhatsAppOutboxItem[]> {
    const nowTime = Date.now();
    const claimed: WhatsAppOutboxItem[] = [];

    const eligible = Array.from(this.outbox.values())
      .filter((o) => {
        if ((o.status === 'PENDING' || o.status === 'FAILED') && new Date(o.nextAttemptAt).getTime() <= nowTime) {
          return true;
        }
        if (o.status === 'SENDING' && o.lockedUntil && new Date(o.lockedUntil).getTime() < nowTime) {
          return true;
        }
        return false;
      })
      .sort((a, b) => new Date(a.nextAttemptAt).getTime() - new Date(b.nextAttemptAt).getTime())
      .slice(0, limit);

    for (const item of eligible) {
      const lockedUntil = new Date(nowTime + leaseSeconds * 1000).toISOString();
      const updated: WhatsAppOutboxItem = {
        ...item,
        status: 'SENDING',
        workerId,
        lockedUntil,
      };
      this.outbox.set(item.id, updated);
      claimed.push(updated);
    }

    return claimed;
  }

  public async renewOutboxLease(id: string, workerId: string, additionalSeconds = 120): Promise<boolean> {
    const item = this.outbox.get(id);
    if (!item) return false;
    const nowTime = Date.now();

    if (item.workerId !== workerId || !item.lockedUntil || new Date(item.lockedUntil).getTime() < nowTime) {
      return false;
    }

    item.lockedUntil = new Date(nowTime + additionalSeconds * 1000).toISOString();
    this.outbox.set(id, item);
    return true;
  }

  public async completeOutboxItem(
    id: string,
    workerId: string,
    providerMessageId?: string
  ): Promise<boolean> {
    const item = this.outbox.get(id);
    if (!item) return false;
    const nowTime = Date.now();

    if (item.workerId !== workerId || (item.lockedUntil && new Date(item.lockedUntil).getTime() < nowTime)) {
      return false;
    }

    item.status = 'SENT';
    item.sentAt = new Date().toISOString();
    item.providerMessageId = providerMessageId || null;
    item.lockedUntil = null;
    this.outbox.set(id, item);
    return true;
  }

  public async failOutboxItem(id: string, workerId: string, error: string): Promise<boolean> {
    const item = this.outbox.get(id);
    if (!item) return false;

    if (item.workerId !== workerId) return false;

    item.attemptCount += 1;
    item.lastError = error;
    item.lockedUntil = null;

    if (item.attemptCount >= item.maxAttempts) {
      item.status = 'DEAD_LETTER';
    } else {
      item.status = 'FAILED';
      const delayMs = Math.pow(2, item.attemptCount) * 2000;
      item.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    }

    this.outbox.set(id, item);
    return true;
  }

  // --------------------------------------------------------------------------
  // Phase 2: Message Audit Trail & Documents
  // --------------------------------------------------------------------------
  public async recordWhatsAppMessage(message: {
    conversationId: string;
    messageId: string;
    direction: 'INBOUND' | 'OUTBOUND';
    messageType: string;
    body?: string | null;
    mediaUrl?: string | null;
    mediaMimeType?: string | null;
    rawPayload?: Record<string, unknown>;
  }): Promise<WhatsAppMessage> {
    const created: WhatsAppMessage = {
      id: crypto.randomUUID(),
      conversationId: message.conversationId,
      messageId: message.messageId,
      direction: message.direction,
      messageType: message.messageType,
      body: message.body || null,
      mediaUrl: message.mediaUrl || null,
      mediaMimeType: message.mediaMimeType || null,
      rawPayload: message.rawPayload || {},
      createdAt: new Date().toISOString(),
    };

    this.whatsappMessages.push(created);
    return created;
  }

  public async listWhatsAppMessages(conversationId: string, limit = 50): Promise<WhatsAppMessage[]> {
    return this.whatsappMessages
      .filter((m) => m.conversationId === conversationId)
      .slice(-limit);
  }

  public async verifyDocumentExists(storagePath: string): Promise<boolean> {
    return storagePath ? true : false;
  }

  public async clear(): Promise<void> {
    this.shops.clear();
    this.orders.clear();
    this.jobs.clear();
    this.events = [];
    this.printers.clear();
    this.agents.clear();
    this.transactions.clear();
    this.conversations.clear();
    this.inbox.clear();
    this.outbox.clear();
    this.whatsappMessages = [];
    this.storedDocuments.clear();
    this.seedDefaults();
  }
}