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

export interface DashboardMetrics {
  todayOrders: number;
  queued: number;
  printing: number;
  completed: number;
  failed: number;
  revenuePaisa: number;
  pagesPrinted: number;
}

export class UnauthorizedAgentJobError extends Error {
  constructor(agentId: string, jobId: string) {
    super(`Agent "${agentId}" is not authorized to access or modify Job "${jobId}".`);
    this.name = 'UnauthorizedAgentJobError';
  }
}

export class ResourceNotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} with ID "${id}" was not found.`);
    this.name = 'ResourceNotFoundError';
  }
}

export class StaleConversationVersionError extends Error {
  constructor(phone: string, expectedVersion: number) {
    super(`Concurrent modification detected on conversation for "${phone}". Expected version ${expectedVersion}.`);
    this.name = 'StaleConversationVersionError';
  }
}

export interface IPrintOSRepository {
  // Order operations
  createOrder(order: PrintOrder): Promise<PrintOrder>;
  getOrder(id: string): Promise<PrintOrder | null>;
  getOrderByNumber(orderNumber: string): Promise<PrintOrder | null>;
  listOrders(filters?: { status?: OrderStatus; limit?: number }): Promise<PrintOrder[]>;
  updateOrderStatus(
    orderId: string,
    nextStatus: OrderStatus,
    metadata?: Record<string, unknown>
  ): Promise<PrintOrder>;

  // Audit Events
  recordOrderEvent(
    orderId: string,
    eventType: string,
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<PrintOrderEvent>;
  getOrderEvents(orderId: string): Promise<PrintOrderEvent[]>;

  // Payment & Idempotency
  simulateVerifiedPayment(
    orderId: string,
    transactionId: string,
    provider?: string,
    amountPaisa?: number
  ): Promise<{ order: PrintOrder; job: PrintJob; isDuplicate: boolean }>;

  // Print Jobs & Atomic Queue Claiming
  getJob(id: string): Promise<PrintJob | null>;
  getJobByOrderId(orderId: string): Promise<PrintJob | null>;
  listJobs(filters?: { status?: JobStatus; limit?: number }): Promise<PrintJob[]>;
  claimNextPrintJob(agentId: string, printerId?: string): Promise<ClaimedJob | null>;
  updateJobStatus(jobId: string, agentId: string, update: AgentJobStatusUpdate): Promise<PrintJob>;

  // Agents & Printers
  authenticateAgent(providedKey: string): Promise<PrintAgent | null>;
  recordAgentHeartbeat(
    agentName: string,
    printerStatus: PrinterStatus,
    capabilities?: Record<string, unknown>,
    version?: string
  ): Promise<PrintAgent>;
  listPrinters(): Promise<Printer[]>;

  // Metrics
  getDashboardMetrics(): Promise<DashboardMetrics>;

  // Phase 2: WhatsApp Conversations & Locking
  getConversation(customerPhone: string): Promise<WhatsAppConversation | null>;
  upsertConversation(conversation: Partial<WhatsAppConversation> & { customerPhone: string }): Promise<WhatsAppConversation>;
  updateConversationState(
    customerPhone: string,
    nextState: ConversationState,
    sessionData?: ConversationSessionData,
    activeOrderId?: string | null,
    expectedVersion?: number
  ): Promise<WhatsAppConversation>;

  // Phase 2: WhatsApp Inbox
  enqueueInboxItem(item: {
    messageId: string;
    senderPhone: string;
    rawPayload: Record<string, unknown>;
  }): Promise<{ item: WhatsAppInboxItem; isDuplicate: boolean }>;
  claimInboxBatch(workerId: string, limit?: number, leaseSeconds?: number): Promise<WhatsAppInboxItem[]>;
  renewInboxLease(id: string, workerId: string, additionalSeconds?: number): Promise<boolean>;
  completeInboxItem(id: string, workerId: string): Promise<boolean>;
  failInboxItem(id: string, workerId: string, error: string, retryable?: boolean): Promise<boolean>;

  // Phase 2: WhatsApp Outbox
  enqueueOutboxItem(item: {
    conversationId?: string | null;
    orderId?: string | null;
    recipientPhone: string;
    messageType: OutboxMessageType;
    payload: WhatsAppOutboxPayload;
  }): Promise<WhatsAppOutboxItem>;
  claimOutboxBatch(workerId: string, limit?: number, leaseSeconds?: number): Promise<WhatsAppOutboxItem[]>;
  renewOutboxLease(id: string, workerId: string, additionalSeconds?: number): Promise<boolean>;
  completeOutboxItem(id: string, workerId: string, providerMessageId?: string): Promise<boolean>;
  failOutboxItem(id: string, workerId: string, error: string): Promise<boolean>;

  // Phase 2: Message Audit Trail & Document Validation
  recordWhatsAppMessage(message: {
    conversationId: string;
    messageId: string;
    direction: 'INBOUND' | 'OUTBOUND';
    messageType: string;
    body?: string | null;
    mediaUrl?: string | null;
    mediaMimeType?: string | null;
    rawPayload?: Record<string, unknown>;
  }): Promise<WhatsAppMessage>;
  listWhatsAppMessages(conversationId: string, limit?: number): Promise<WhatsAppMessage[]>;
  verifyDocumentExists(storagePath: string): Promise<boolean>;

  // Testing helper
  clear?(): Promise<void>;
}