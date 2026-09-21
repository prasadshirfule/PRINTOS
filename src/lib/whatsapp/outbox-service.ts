import {
  WhatsAppButton,
  WhatsAppOutboxItem,
  WhatsAppOutboxPayload,
} from '@/types/whatsapp';
import { OrderStatus } from '@/types/printos';
import { IPrintOSRepository } from '@/lib/repository';

export class WhatsAppOutboxService {
  public static async queueText(
    repo: IPrintOSRepository,
    recipientPhone: string,
    body: string,
    conversationId?: string | null,
    orderId?: string | null,
    idempotencyKey?: string
  ): Promise<WhatsAppOutboxItem> {
    return repo.enqueueOutboxItem({
      conversationId,
      orderId,
      recipientPhone,
      messageType: 'text',
      payload: { body, idempotencyKey },
    });
  }

  public static async queueButtons(
    repo: IPrintOSRepository,
    recipientPhone: string,
    body: string,
    buttons: WhatsAppButton[],
    headerText?: string,
    footerText?: string,
    conversationId?: string | null,
    orderId?: string | null,
    idempotencyKey?: string
  ): Promise<WhatsAppOutboxItem> {
    return repo.enqueueOutboxItem({
      conversationId,
      orderId,
      recipientPhone,
      messageType: 'interactive',
      payload: {
        body,
        buttons,
        headerText,
        footerText,
        idempotencyKey,
      },
    });
  }

  public static async queueDocument(
    repo: IPrintOSRepository,
    recipientPhone: string,
    mediaUrl: string,
    filename: string,
    caption?: string,
    conversationId?: string | null,
    orderId?: string | null,
    idempotencyKey?: string
  ): Promise<WhatsAppOutboxItem> {
    return repo.enqueueOutboxItem({
      conversationId,
      orderId,
      recipientPhone,
      messageType: 'document',
      payload: {
        mediaUrl,
        filename,
        caption,
        idempotencyKey,
      },
    });
  }

  public static async queueStatusAlert(
    repo: IPrintOSRepository,
    recipientPhone: string,
    orderNumber: string,
    status: OrderStatus,
    conversationId?: string | null,
    orderId?: string | null,
    idempotencyKey?: string
  ): Promise<WhatsAppOutboxItem> {
    let body = '';
    switch (status) {
      case 'QUEUED':
        body = `✅ Payment verified! Your Order *#${orderNumber}* has been queued for printing. We will notify you once printing begins.`;
        break;
      case 'PRINTING':
        body = `🖨️ Printing started! Your Order *#${orderNumber}* is currently being printed at the counter.`;
        break;
      case 'COMPLETED':
        body = `🎉 Order *#${orderNumber}* is READY! You can collect your printed documents from the counter. Thank you for using PRINTOS!`;
        break;
      case 'FAILED':
        body = `⚠️ An issue occurred with Order *#${orderNumber}*. Please check with the counter staff for immediate assistance.`;
        break;
      default:
        body = `ℹ️ Order *#${orderNumber}* status updated to *${status}*.`;
    }

    const key = idempotencyKey || (orderId ? `${orderId}:${status}` : undefined);

    return repo.enqueueOutboxItem({
      conversationId,
      orderId,
      recipientPhone,
      messageType: 'text',
      payload: { body, idempotencyKey: key },
    });
  }
}
