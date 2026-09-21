import { IPrintOSRepository } from '@/lib/repository';
import { PrintOrder, OrderStatus } from '@/types/printos';
import { WhatsAppOutboxService } from './outbox-service';
import { ConversationState } from '@/types/whatsapp';

export function sanitizeCustomerFailureReason(errorMessage?: string): string {
  if (!errorMessage) {
    return 'Printer hardware or spooler issue';
  }
  const msg = errorMessage.toLowerCase();

  if (
    msg.includes('sumatrapdf') ||
    msg.includes('pdf printing engine') ||
    msg.includes('no application is associated')
  ) {
    return 'PDF printing engine is unavailable';
  }
  if (
    msg.includes('printer') &&
    (msg.includes('not found') ||
      msg.includes('not valid') ||
      msg.includes('unavailable') ||
      msg.includes('offline'))
  ) {
    return 'Printer unavailable';
  }
  if (
    msg.includes('download') ||
    msg.includes('fetch') ||
    msg.includes('storage') ||
    msg.includes('document file not found')
  ) {
    return 'Document download failed';
  }
  if (
    msg.includes('jam') ||
    msg.includes('door') ||
    msg.includes('tray') ||
    msg.includes('out of paper')
  ) {
    return 'Printer paper jam or hardware issue';
  }
  if (
    msg.includes('spooler') ||
    msg.includes('drawing') ||
    msg.includes('powershell')
  ) {
    return 'Printer spooler error';
  }
  return 'Unknown printing error';
}

export class NotificationService {
  /**
   * Dispatches a durable transactional outbox notification and syncs conversation state
   * when an order status changes.
   */
  public static async notifyOrderStatus(
    repo: IPrintOSRepository,
    order: PrintOrder,
    newStatus: OrderStatus,
    reason?: string
  ): Promise<void> {
    const conv = await repo.getConversation(order.customerPhone, order.shopId || undefined);
    let messageText = '';
    let targetState: ConversationState | null = null;

    switch (newStatus) {
      case 'PRINTING':
        messageText = `🖨️ Printing started! Your Order *#${order.orderNumber}* is currently being printed at the counter.`;
        targetState = 'ORDER_PRINTING';
        break;

      case 'COMPLETED':
        messageText =
          `🎉 *Order Ready for Pickup!*\n\n` +
          `Your print order *#${order.orderNumber}* is complete and ready at the shop counter.\n\n` +
          `*Summary:*\n` +
          `• Pages: ${order.pageCount}\n` +
          `• Copies: ${order.copies}\n` +
          `• Total Paid: ₹${(order.totalAmountPaisa / 100).toFixed(2)}\n\n` +
          `Thank you for using PRINTOS! Type *hi* anytime to start a new order.`;
        targetState = 'ORDER_COMPLETED';
        break;

      case 'FAILED': {
        const safeReason = sanitizeCustomerFailureReason(reason);
        messageText =
          `⚠️ Printing failed for Order *#${order.orderNumber}*.\n\n` +
          `Reason: ${safeReason}.\n\n` +
          `Please check with the counter staff for assistance.`;
        targetState = 'ORDER_FAILED';
        break;
      }

      case 'CANCELLED':
        messageText =
          `❌ *Order Cancelled*\n\n` +
          `Your order *#${order.orderNumber}* has been cancelled.`;
        targetState = 'CANCELLED';
        break;

      case 'REFUND_PENDING':
        messageText =
          `⚠️ *Refund Pending*\n\n` +
          `Your order *#${order.orderNumber}* requires a manual refund. Our team will assist you.`;
        targetState = 'ORDER_FAILED';
        break;

      default:
        return;
    }

    const recipient =
      conv?.whatsappChatId ||
      conv?.sessionData?.whatsappChatId ||
      order.customerPhone;

    // Queue durable outbox notification
    await WhatsAppOutboxService.queueStatusAlert(
      repo,
      recipient,
      order.orderNumber,
      newStatus,
      conv?.id,
      order.id,
      `${order.id}:${newStatus}`,
      messageText,
      reason
    );

    // Sync conversation state if conversation exists
    if (conv && targetState) {
      await repo.updateConversationState(
        conv.customerPhone,
        targetState,
        {
          ...conv.sessionData,
          orderId: order.id,
          orderStatus: newStatus,
        },
        order.id,
        conv.version,
        order.shopId || undefined
      );
    }
  }
}
