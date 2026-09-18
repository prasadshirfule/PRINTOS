import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';
import { getPaymentProvider, FulfillabilityPolicy } from '@/lib/payment';
import { WhatsAppOutboxService } from '@/lib/whatsapp/outbox-service';
import { globalRateLimiter } from '@/lib/security/rate-limiter';
import { createLogger } from '@/lib/observability/logger';

const logger = createLogger('PaymentWebhookRoute');

export async function POST(req: NextRequest) {
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anonymous';
  const rateLimit = globalRateLimiter.check(`pay_webhook_${clientIp}`, 120, 60);

  if (!rateLimit.allowed) {
    logger.warn('Rate limit exceeded on payment webhook', { clientIp });
    return NextResponse.json(
      { error: 'Too many payment webhook requests. Please slow down.' },
      {
        status: 429,
        headers: { 'Retry-After': String(rateLimit.resetInSeconds) },
      }
    );
  }

  try {
    const rawBody = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const paymentProvider = getPaymentProvider();
    const verification = await paymentProvider.verifyWebhook(headers, rawBody);

    if (!verification.isValid) {
      logger.warn('Invalid payment webhook signature', { clientIp, error: verification.error });
      return NextResponse.json(
        { error: verification.error || 'Invalid payment webhook signature' },
        { status: 400 }
      );
    }

    const { orderId, transactionId, amountPaisa, status, provider } = verification;
    const repo = getRepository();

    if (!orderId) {
      logger.warn('Missing orderId in payment webhook', { clientIp, transactionId });
      return NextResponse.json({ error: 'Missing orderId in payment webhook' }, { status: 400 });
    }

    const order = await repo.getOrder(orderId);
    if (!order) {
      logger.warn('Order not found for payment webhook', { orderId, transactionId });
      return NextResponse.json({ error: `Order ${orderId} not found` }, { status: 404 });
    }

    if (status !== 'SUCCESS') {
      logger.warn('Payment attempt failed', { orderId, transactionId, provider });
      await repo.recordOrderEvent(order.id, 'PAYMENT_FAILED', `Payment attempt failed via ${provider}`, {
        transactionId,
        rawResponse: verification.rawPayload,
      });

      return NextResponse.json({
        success: true,
        message: 'Failed payment recorded',
        orderId: order.id,
      });
    }

    // Strict amount reconciliation: incoming amount in paisa must match order total
    if (order.totalAmountPaisa > 0 && amountPaisa !== order.totalAmountPaisa) {
      logger.error('Payment amount mismatch detected', {
        orderId,
        transactionId,
        expectedPaisa: order.totalAmountPaisa,
        receivedPaisa: amountPaisa,
      });

      await repo.recordOrderEvent(
        order.id,
        'PAYMENT_AMOUNT_MISMATCH',
        `Payment amount mismatch: expected ${order.totalAmountPaisa} paisa, received ${amountPaisa} paisa`,
        {
          expectedPaisa: order.totalAmountPaisa,
          receivedPaisa: amountPaisa,
          transactionId,
          provider,
        }
      );

      return NextResponse.json(
        {
          error: `Payment amount mismatch: expected ${order.totalAmountPaisa} paisa, received ${amountPaisa} paisa`,
          orderId: order.id,
        },
        { status: 400 }
      );
    }

    const conv = await repo.getConversation(order.customerPhone);

    // Case 1: Standard Payment for Active Pending Order (or AWAITING_PAYMENT / CONFIGURING / RECEIVED)
    if (order.status === 'AWAITING_PAYMENT' || order.status === 'CONFIGURING' || order.status === 'RECEIVED') {
      const { order: updatedOrder, job, isDuplicate } = await repo.simulateVerifiedPayment(
        order.id,
        transactionId,
        provider,
        amountPaisa
      );

      if (isDuplicate) {
        logger.info('Payment already processed idempotently', { orderId: updatedOrder.id, transactionId });
        return NextResponse.json({
          success: true,
          message: 'Payment already processed idempotently',
          orderId: updatedOrder.id,
          jobId: job?.id,
          status: updatedOrder.status,
          isDuplicate: true,
        });
      }

      logger.info('Payment accepted and order queued', {
        orderId: updatedOrder.id,
        orderNumber: updatedOrder.orderNumber,
        jobId: job?.id,
        amountPaisa,
        transactionId,
      });

      if (conv) {
        await repo.updateConversationState(
          conv.customerPhone,
          'ORDER_QUEUED',
          {
            ...conv.sessionData,
            orderId: updatedOrder.id,
            jobId: job?.id,
            paymentStatus: 'PAID',
          },
          updatedOrder.id,
          conv.version
        );

        await WhatsAppOutboxService.queueText(
          repo,
          conv.customerPhone,
          `✅ *Payment Confirmed!* (₹${(amountPaisa / 100).toFixed(2)})\n\n` +
            `Your order *#${updatedOrder.orderNumber}* is now queued for printing.\n` +
            `We will notify you the moment your document starts printing!`,
          conv.id,
          updatedOrder.id
        );
      }

      return NextResponse.json({
        success: true,
        message: 'Payment accepted and order queued',
        orderId: updatedOrder.id,
        jobId: job?.id,
        status: 'QUEUED',
      });
    }

    // Case 2: Late Payment on Expired Order -> Evaluate Fulfillability
    if (order.status === 'EXPIRED') {
      const assessment = await FulfillabilityPolicy.isOrderFulfillable(order, repo);

      if (assessment.fulfillable) {
        logger.info('Late payment accepted and order resurrected', { orderId: order.id, transactionId });
        const { order: updatedOrder, job } = await repo.simulateVerifiedPayment(
          order.id,
          transactionId,
          provider,
          amountPaisa
        );

        if (conv) {
          await repo.updateConversationState(
            conv.customerPhone,
            'ORDER_QUEUED',
            {
              ...conv.sessionData,
              orderId: updatedOrder.id,
              jobId: job?.id,
              paymentStatus: 'PAID',
            },
            updatedOrder.id,
            conv.version
          );

          await WhatsAppOutboxService.queueText(
            repo,
            conv.customerPhone,
            `✅ *Late Payment Accepted!*\n\n` +
              `Your order *#${updatedOrder.orderNumber}* has been reactivated and queued for printing.\n` +
              `We will update you as soon as it prints.`,
            conv.id,
            updatedOrder.id
          );
        }

        return NextResponse.json({
          success: true,
          message: 'Late payment accepted and order resurrected',
          orderId: updatedOrder.id,
          jobId: job?.id,
          status: 'QUEUED',
        });
      } else {
        logger.warn('Late payment unfulfillable; flagged for refund', {
          orderId: order.id,
          reason: assessment.reason,
        });

        const updatedOrder = await repo.updateOrderStatus(order.id, 'REFUND_PENDING', {
          reason: assessment.reason,
          transactionId,
        });

        if (conv) {
          await repo.updateConversationState(
            conv.customerPhone,
            'ORDER_FAILED',
            {
              ...conv.sessionData,
              orderId: order.id,
              paymentStatus: 'PAID_NON_FULFILLABLE',
            },
            order.id,
            conv.version
          );

          await WhatsAppOutboxService.queueText(
            repo,
            conv.customerPhone,
            `⚠️ *Payment Received for Expired Order*\n\n` +
              `We received your payment of ₹${(amountPaisa / 100).toFixed(2)}, but order *#${order.orderNumber}* cannot be fulfilled at this time (${assessment.reason || 'Service unavailable'}).\n\n` +
              `Our support team has been notified to process your manual refund.`,
            conv.id,
            order.id
          );
        }

        return NextResponse.json({
          success: true,
          message: 'Late payment unfulfillable; flagged for refund',
          orderId: updatedOrder.id,
          status: 'REFUND_PENDING',
          reason: assessment.reason,
        });
      }
    }

    // Case 3: Payment on Cancelled order
    if (order.status === 'CANCELLED') {
      logger.warn('Payment received on cancelled order', { orderId: order.id, transactionId });
      await repo.recordOrderEvent(
        order.id,
        'PAYMENT_ON_CANCELLED_ORDER',
        `Payment received for already cancelled order. Manual refund required.`,
        { transactionId, amountPaisa }
      );

      if (conv) {
        await WhatsAppOutboxService.queueText(
          repo,
          conv.customerPhone,
          `⚠️ *Payment Received for Cancelled Order*\n\n` +
            `We received your payment for cancelled order *#${order.orderNumber}*. A manual refund has been initiated.`,
          conv.id,
          order.id
        );
      }

      return NextResponse.json({
        success: true,
        message: 'Payment on cancelled order flagged for refund',
        orderId: order.id,
        status: 'REFUND_PENDING',
      });
    }

    // If order was already paid / queued / completed
    logger.info('Payment already completed for order in status', { orderId: order.id, status: order.status });
    return NextResponse.json({
      success: true,
      message: `Payment already processed for order in status ${order.status}`,
      orderId: order.id,
      status: order.status,
      isDuplicate: true,
    });
  } catch (err: unknown) {
    logger.error('Payment Webhook Error', err instanceof Error ? err : undefined);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to process payment webhook' },
      { status: 500 }
    );
  }
}
