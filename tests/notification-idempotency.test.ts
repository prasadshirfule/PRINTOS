import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { getRepository } from '@/lib/repository';
import { PrintOrder } from '@/types/printos';
import { NotificationService } from '@/lib/whatsapp/notification-service';
import { POST as handleStatusUpdate } from '@/app/api/agent/jobs/[id]/status/route';
import { NextRequest } from 'next/server';

describe('WhatsApp Print Status Notification Idempotency Suite', () => {
  const repo = getRepository();
  const validAgentApiKey = 'test-agent-secret-token';
  const agentId = '00000000-0000-0000-0000-000000000002';
  const apiKeyHash = crypto.createHash('sha256').update(validAgentApiKey).digest('hex');

  beforeEach(async () => {
    if (repo.clear) {
      await repo.clear();
    }
    const agent = (repo as any).agents.get(agentId);
    if (agent) {
      agent.apiKeyHash = apiKeyHash;
    }
  });

  const getOutboxForOrder = (orderId: string) => {
    const outboxMap = (repo as any).outbox as Map<string, any>;
    return Array.from(outboxMap.values()).filter((item) => item.orderId === orderId);
  };

  const createTestOrder = async (orderId: string, orderNumber: string, phone = '919876543210'): Promise<PrintOrder> => {
    const order: PrintOrder = {
      id: orderId,
      orderNumber,
      customerPhone: phone,
      status: 'AWAITING_PAYMENT',
      originalFilename: 'document.pdf',
      storagePath: `orders/${orderId}/document.pdf`,
      fileType: 'pdf',
      fileSize: 2048,
      pageCount: 2,
      paperSize: 'A4',
      colorMode: 'BW',
      printSides: 'ONE_SIDED',
      copies: 1,
      selectedPageCount: 2,
      subtotalPaisa: 400,
      discountPaisa: 0,
      totalAmountPaisa: 400,
      currency: 'INR',
      paymentStatus: 'PENDING',
      createdAt: new Date().toISOString(),
    };
    return repo.createOrder(order);
  };

  it('1. Same job transitions to PRINTING twice: only one WhatsApp printing notification', async () => {
    const order = await createTestOrder('ord-dup-printing', 'P10001');
    await repo.simulateVerifiedPayment(order.id, 'tx_p10001');

    // Call notifyOrderStatus multiple times for PRINTING
    await NotificationService.notifyOrderStatus(repo, order, 'PRINTING');
    await NotificationService.notifyOrderStatus(repo, order, 'PRINTING');

    const outboxItems = getOutboxForOrder(order.id);
    const printingNotifications = outboxItems.filter(
      (item) => item.payload.idempotencyKey === `${order.id}:PRINTING`
    );

    expect(printingNotifications.length).toBe(1);
  });

  it('2. Same job fails multiple times/retries: suppresses intermediate failure alerts and sends only one final failure notification', async () => {
    const order = await createTestOrder('ord-retry-fail', 'P10002');
    const { job } = await repo.simulateVerifiedPayment(order.id, 'tx_p10002');

    const createStatusRequest = (body: { status: 'PRINTING' | 'COMPLETED' | 'FAILED'; errorMessage?: string }) => {
      return new NextRequest(`http://localhost:3000/api/agent/jobs/${job.id}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-key': validAgentApiKey,
        },
        body: JSON.stringify(body),
      });
    };

    // Attempt 1: Claim -> PRINTING -> FAILED (re-queued as RETRY_PENDING)
    await repo.claimNextPrintJob(agentId);
    const resPrinting1 = await handleStatusUpdate(createStatusRequest({ status: 'PRINTING' }), { params: { id: job.id } });
    expect(resPrinting1.status).toBe(200);

    const resFail1 = await handleStatusUpdate(createStatusRequest({ status: 'FAILED', errorMessage: 'Paper jam attempt 1' }), { params: { id: job.id } });
    expect(resFail1.status).toBe(200);

    let currentJob = await repo.getJob(job.id);
    expect(currentJob?.status).toBe('RETRY_PENDING');

    // Outbox should have 1 PRINTING notification and 0 FAILED notifications so far
    let outboxItems = getOutboxForOrder(order.id);
    expect(outboxItems.filter((i) => i.payload.idempotencyKey === `${order.id}:PRINTING`).length).toBe(1);
    expect(outboxItems.filter((i) => i.payload.idempotencyKey === `${order.id}:FAILED`).length).toBe(0);

    // Attempt 2: Claim -> PRINTING -> FAILED (re-queued as RETRY_PENDING)
    await repo.claimNextPrintJob(agentId);
    const resPrinting2 = await handleStatusUpdate(createStatusRequest({ status: 'PRINTING' }), { params: { id: job.id } });
    expect(resPrinting2.status).toBe(200);

    const resFail2 = await handleStatusUpdate(createStatusRequest({ status: 'FAILED', errorMessage: 'Paper jam attempt 2' }), { params: { id: job.id } });
    expect(resFail2.status).toBe(200);

    currentJob = await repo.getJob(job.id);
    expect(currentJob?.status).toBe('RETRY_PENDING');

    outboxItems = getOutboxForOrder(order.id);
    // Still exactly 1 PRINTING notification and 0 FAILED notifications
    expect(outboxItems.filter((i) => i.payload.idempotencyKey === `${order.id}:PRINTING`).length).toBe(1);
    expect(outboxItems.filter((i) => i.payload.idempotencyKey === `${order.id}:FAILED`).length).toBe(0);

    // Attempt 3: Claim -> FAILED (reaches maxAttempts 3 -> terminal FAILED)
    await repo.claimNextPrintJob(agentId);
    const resFail3 = await handleStatusUpdate(createStatusRequest({ status: 'FAILED', errorMessage: 'Final hardware fault' }), { params: { id: job.id } });
    expect(resFail3.status).toBe(200);

    currentJob = await repo.getJob(job.id);
    expect(currentJob?.status).toBe('FAILED');

    outboxItems = getOutboxForOrder(order.id);
    expect(outboxItems.filter((i) => i.payload.idempotencyKey === `${order.id}:PRINTING`).length).toBe(1);
    expect(outboxItems.filter((i) => i.payload.idempotencyKey === `${order.id}:FAILED`).length).toBe(1);

    // Simulating another duplicate failure call does not generate a 2nd failure notification
    const orderObj = await repo.getOrder(order.id);
    if (orderObj) {
      await NotificationService.notifyOrderStatus(repo, orderObj, 'FAILED', 'Duplicate fail event');
    }

    outboxItems = getOutboxForOrder(order.id);
    expect(outboxItems.filter((i) => i.payload.idempotencyKey === `${order.id}:FAILED`).length).toBe(1);
  });

  it('3. Same job is processed concurrently: still only one notification', async () => {
    const order = await createTestOrder('ord-concurrent', 'P10003');
    await repo.simulateVerifiedPayment(order.id, 'tx_p10003');

    // Trigger concurrent notification dispatch
    await Promise.all([
      NotificationService.notifyOrderStatus(repo, order, 'PRINTING'),
      NotificationService.notifyOrderStatus(repo, order, 'PRINTING'),
      NotificationService.notifyOrderStatus(repo, order, 'PRINTING'),
    ]);

    const outboxItems = getOutboxForOrder(order.id);
    const printingItems = outboxItems.filter((i) => i.payload.idempotencyKey === `${order.id}:PRINTING`);
    expect(printingItems.length).toBe(1);
  });

  it('4. Different print jobs for the same customer: each job generates its own notifications', async () => {
    const customerPhone = '919876543210';
    const order1 = await createTestOrder('ord-cust-1', 'P10004', customerPhone);
    const order2 = await createTestOrder('ord-cust-2', 'P10005', customerPhone);

    await repo.simulateVerifiedPayment(order1.id, 'tx_p10004');
    await repo.simulateVerifiedPayment(order2.id, 'tx_p10005');

    await NotificationService.notifyOrderStatus(repo, order1, 'PRINTING');
    await NotificationService.notifyOrderStatus(repo, order2, 'PRINTING');

    const outbox1 = getOutboxForOrder(order1.id);
    const outbox2 = getOutboxForOrder(order2.id);

    expect(outbox1.length).toBe(1);
    expect(outbox1[0].payload.idempotencyKey).toBe(`${order1.id}:PRINTING`);
    expect(outbox2.length).toBe(1);
    expect(outbox2[0].payload.idempotencyKey).toBe(`${order2.id}:PRINTING`);
  });

  it('5. Successful completion still produces the expected notification exactly once', async () => {
    const order = await createTestOrder('ord-completed-test', 'P10006');
    const { job } = await repo.simulateVerifiedPayment(order.id, 'tx_p10006');

    await repo.claimNextPrintJob(agentId);

    const updateStatus = async (status: 'PRINTING' | 'COMPLETED') => {
      const req = new NextRequest(`http://localhost:3000/api/agent/jobs/${job.id}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-key': validAgentApiKey,
        },
        body: JSON.stringify({ status }),
      });
      return handleStatusUpdate(req, { params: { id: job.id } });
    };

    const res1 = await updateStatus('PRINTING');
    expect(res1.status).toBe(200);

    const res2 = await updateStatus('COMPLETED');
    expect(res2.status).toBe(200);

    // Duplicate completed call
    const orderObj = await repo.getOrder(order.id);
    if (orderObj) {
      await NotificationService.notifyOrderStatus(repo, orderObj, 'COMPLETED');
    }

    const outboxItems = getOutboxForOrder(order.id);
    const printingNotifications = outboxItems.filter((i) => i.payload.idempotencyKey === `${order.id}:PRINTING`);
    const completedNotifications = outboxItems.filter((i) => i.payload.idempotencyKey === `${order.id}:COMPLETED`);

    expect(printingNotifications.length).toBe(1);
    expect(completedNotifications.length).toBe(1);
  });
});
