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

  // Testing helper
  clear?(): Promise<void>;
}