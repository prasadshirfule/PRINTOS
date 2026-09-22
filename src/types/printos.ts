export const DEFAULT_SHOP_ID = '00000000-0000-0000-0000-000000000001';

export interface Shop {
  id: string;
  name: string;
  slug: string;
  phone?: string | null;
  address?: string | null;
  currency: string;
  timezone?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type OrderStatus =
  | 'RECEIVED'
  | 'CONFIGURING'
  | 'AWAITING_PAYMENT'
  | 'PAID'
  | 'QUEUED'
  | 'WAITING_FOR_PRINTER'
  | 'PRINTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REFUND_PENDING';

export type JobStatus =
  | 'QUEUED'
  | 'CLAIMED'
  | 'PRINTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'RETRY_PENDING';

export type PaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED';

export type ColorMode = 'BW' | 'COLOR';
export type PaperSize = 'A4' | 'A5';
export type PrintSides = 'ONE_SIDED' | 'BOTH_SIDES';
export type FileType = 'pdf' | 'jpg' | 'jpeg' | 'png';

export type PrinterStatus = 'ONLINE' | 'OFFLINE' | 'BUSY' | 'ERROR' | 'PAUSED';
export type AgentStatus = 'ONLINE' | 'OFFLINE' | 'BUSY' | 'ERROR';

export interface PrinterCapabilities {
  supportsColor: boolean;
  supportsDuplex: boolean;
  supportedPaperSizes: PaperSize[];
}

export interface Printer {
  id: string;
  shopId?: string | null;
  name: string;
  location: string;
  status: PrinterStatus;
  isActive: boolean;
  supportsColor: boolean;
  supportsDuplex: boolean;
  supportedPaperSizes: PaperSize[];
  lastSeenAt?: string | null;
  createdAt: string;
}

export interface PrintAgent {
  id: string;
  shopId?: string | null;
  agentName: string;
  apiKeyHash: string;
  status: AgentStatus;
  version: string;
  capabilities: Record<string, unknown>;
  lastSeenAt?: string | null;
  createdAt: string;
}

export interface PricingConfig {
  shopId?: string | null;
  defaultPaper: PaperSize;
  bwPricePaisa: number;          // e.g. 200 = ₹2.00
  colorPricePaisa: number;       // e.g. 1000 = ₹10.00
  duplexPricePaisa: number;      // e.g. 200 = ₹2.00
  a5BwPricePaisa: number;        // e.g. 100 = ₹1.00
  a5ColorPricePaisa: number;     // e.g. 500 = ₹5.00
  maxCopies: number;             // e.g. 50
  maxFileSizeBytes: number;      // e.g. 52428800 (50MB)
  allowedFileTypes: FileType[];
  retentionHours: number;        // e.g. 24
}

export interface PrintOrder {
  id: string;
  shopId?: string | null;
  orderNumber: string;
  customerPhone: string;
  customerName?: string | null;
  status: OrderStatus;
  originalFilename: string;
  storagePath: string;
  fileType: FileType;
  fileSize: number;
  pageCount: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  printSides: PrintSides;
  copies: number;
  pageSelection?: string | null;
  selectedPageCount: number;
  subtotalPaisa: number;
  discountPaisa: number;
  totalAmountPaisa: number;
  currency: string;
  paymentStatus: PaymentStatus;
  paymentId?: string | null;
  printerId?: string | null;
  createdAt: string;
  paidAt?: string | null;
  queuedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
}

export interface PrintOrderEvent {
  id: string;
  orderId: string;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface PrintJob {
  id: string;
  shopId?: string | null;
  orderId: string;
  printerId?: string | null;
  agentId?: string | null;
  status: JobStatus;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  documentUrl?: string | null;
  printOptions: Record<string, unknown>;
  errorMessage?: string | null;
  createdAt: string;
  claimedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
}

export interface ClaimedJob {
  jobId: string;
  orderId: string;
  orderNumber: string;
  storagePath: string;
  originalFilename: string;
  printOptions: Record<string, unknown>;
  copies: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  printSides: PrintSides;
  pageSelection?: string | null;
  downloadUrl?: string;
}

export interface AgentHeartbeatPayload {
  agentName: string;
  version: string;
  printerStatus: PrinterStatus;
  capabilities?: Record<string, unknown>;
  currentJobId?: string | null;
}

export interface AgentJobStatusUpdate {
  status: 'PRINTING' | 'COMPLETED' | 'FAILED';
  errorMessage?: string;
}
