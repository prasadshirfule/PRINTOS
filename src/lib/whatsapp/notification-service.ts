import { IPrintOSRepository } from '@/lib/repository';
import { PrintOrder, OrderStatus } from '@/types/printos';
import { WhatsAppOutboxService } from './outbox-service';
import { ConversationState } from '@/types/whatsapp';

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
    const conv = await repo.getConversation(order.customerPhone);
    let messageText = '';
    let targetState: ConversationState | null = null;

    switch (newStatus) {
      case 'PRINTING':
        messageText =
          `🖨️ *Printing Started!*\n\n` +
          `Your order *#${order.orderNumber}* is currently being printed on the shop printer.\n` +
          `We will notify you the moment it finishes!`;
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

      case 'FAILED':
        messageText =
          `⚠️ *Print Job Alert*\n\n` +
          `There was an issue printing your order *#${order.orderNumber}* (${reason || 'Hardware error'}).\n` +
          `The shop operator has been alerted and will assist you at the counter.`;
        targetState = 'ORDER_FAILED';
        break;

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

    // Queue durable outbox notification
    await WhatsAppOutboxService.queueStatusAlert(
      repo,
      order.customerPhone,
      order.orderNumber,
      newStatus,
      conv?.id,
      order.id
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
        conv.version
      );
    }
  }
}
