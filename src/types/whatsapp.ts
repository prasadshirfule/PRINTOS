import { ColorMode, FileType, PaperSize, PrintSides, OrderStatus } from './printos';

export type ConversationState =
  | 'IDLE'
  | 'AWAITING_DOCUMENT'
  | 'DOCUMENT_RECEIVED'
  | 'COLLECTING_COLOR'
  | 'COLLECTING_SIDES'
  | 'COLLECTING_COPIES'
  | 'COLLECTING_PAGES'
  | 'CONFIRMING_ORDER'
  | 'AWAITING_PAYMENT'
  | 'ORDER_QUEUED'
  | 'ORDER_PRINTING'
  | 'ORDER_COMPLETED'
  | 'ORDER_FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

export type InboxStatus =
  | 'RECEIVED'
  | 'PROCESSING'
  | 'PROCESSED'
  | 'RETRYABLE'
  | 'DEAD_LETTER';

export type OutboxStatus =
  | 'PENDING'
  | 'SENDING'
  | 'SENT'
  | 'FAILED'
  | 'DEAD_LETTER';

export type OutboxMessageType =
  | 'text'
  | 'interactive'
  | 'template'
  | 'document'
  | 'image';

export interface WhatsAppButton {
  id: string;
  title: string;
}

export interface ConversationSessionData {
  shopId?: string;
  whatsappChatId?: string;
  documentPath?: string;
  originalFilename?: string;
  fileType?: FileType;
  fileSize?: number;
  pageCount?: number;
  colorMode?: ColorMode;
  printSides?: PrintSides;
  paperSize?: PaperSize;
  copies?: number;
  pageSelection?: string;
  selectedPageCount?: number;
  subtotalPaisa?: number;
  discountPaisa?: number;
  totalAmountPaisa?: number;
  invalidAttempts?: number;
  orderId?: string;
  jobId?: string;
  paymentStatus?: string;
  orderStatus?: OrderStatus;
}

export interface WhatsAppConversation {
  id: string;
  shopId?: string | null;
  customerPhone: string;
  whatsappChatId?: string | null;
  customerName?: string | null;
  currentState: ConversationState;
  activeOrderId?: string | null;
  sessionData: ConversationSessionData;
  version: number;
  lastInteractionAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsAppInboxItem {
  id: string;
  shopId?: string | null;
  messageId: string; // Meta wamid
  senderPhone: string;
  rawPayload: Record<string, unknown>;
  status: InboxStatus;
  workerId?: string | null;
  lockedUntil?: string | null;
  processingStartedAt?: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastError?: string | null;
  receivedAt: string;
  processedAt?: string | null;
}

export interface WhatsAppOutboxPayload {
  text?: string;
  body?: string;
  headerText?: string;
  footerText?: string;
  buttons?: WhatsAppButton[];
  mediaUrl?: string;
  documentUrl?: string;
  filename?: string;
  caption?: string;
  templateName?: string;
  templateLanguage?: string;
  templateComponents?: unknown[];
}

export interface WhatsAppOutboxItem {
  id: string;
  shopId?: string | null;
  conversationId?: string | null;
  orderId?: string | null;
  recipientPhone: string;
  messageType: OutboxMessageType;
  payload: WhatsAppOutboxPayload;
  status: OutboxStatus;
  workerId?: string | null;
  lockedUntil?: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  providerMessageId?: string | null;
  lastError?: string | null;
  createdAt: string;
  sentAt?: string | null;
}

export interface WhatsAppMessage {
  id: string;
  conversationId: string;
  messageId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  messageType: string;
  body?: string | null;
  mediaUrl?: string | null;
  mediaMimeType?: string | null;
  rawPayload: Record<string, unknown>;
  createdAt: string;
}

export interface InboundWhatsAppEvent {
  wamid: string;
  from: string;
  name?: string;
  timestamp: number;
  type: 'text' | 'document' | 'image' | 'interactive' | 'button' | 'unknown';
  text?: string;
  buttonId?: string;
  mediaId?: string;
  mimeType?: string;
  filename?: string;
  fileSize?: number;
  rawPayload: Record<string, unknown>;
}

export interface IWhatsAppProvider {
  sendText(to: string, message: string): Promise<{ providerMessageId: string }>;
  sendInteractiveButtons(
    to: string,
    message: string,
    buttons: WhatsAppButton[],
    headerText?: string,
    footerText?: string
  ): Promise<{ providerMessageId: string }>;
  sendDocument(
    to: string,
    documentUrl: string,
    filename: string,
    caption?: string
  ): Promise<{ providerMessageId: string }>;
  getMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string; fileSize?: number }>;
  downloadMediaStream(mediaUrl: string): Promise<{ stream: NodeJS.ReadableStream; contentLength?: number }>;
}

export interface IWhatsAppService {
  sendText(to: string, message: string): Promise<void>;
  sendInteractiveButtons(to: string, message: string, buttons: WhatsAppButton[]): Promise<void>;
  sendDocument(to: string, documentUrl: string, filename: string, caption?: string): Promise<void>;
  sendStatusMessage(to: string, status: OrderStatus, orderNumber: string): Promise<void>;
}
