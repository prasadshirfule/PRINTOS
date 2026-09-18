import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/webhooks/payment/route';
import { getRepository } from '@/lib/repository';
import { setPaymentProvider, MockPaymentProvider } from '@/lib/payment';
import { PrintOrder } from '@/types/printos';

describe('Payment Webhook Route (/api/webhooks/payment)', () => {
  let mockProvider: MockPaymentProvider;
  const repo = getRepository();

  beforeEach(async () => {
    if (repo.clear) {
      await repo.clear();
    }
    mockProvider = new MockPaymentProvider();
    setPaymentProvider(mockProvider);
  });

  const createTestOrder = async (
    orderId: string,
    orderNumber: string,
    status: any = 'AWAITING_PAYMENT',
    amountPaisa: number = 4800
  ): Promise<PrintOrder> => {
    const order: PrintOrder = {
      id: orderId,
      orderNumber,
      customerPhone: '+919876543210',
      customerName: 'Test Customer',
      status,
      originalFilename: 'notes.pdf',
      storagePath: `orders/${orderId}/notes.pdf`,
      fileType: 'pdf',
      fileSize: 1024,
      pageCount: 12,
      paperSize: 'A4',
      colorMode: 'BW',
      printSides: 'ONE_SIDED',
      copies: 1,
      pageSelection: 'all',
      selectedPageCount: 12,
      subtotalPaisa: amountPaisa,
      discountPaisa: 0,
      totalAmountPaisa: amountPaisa,
      currency: 'INR',
      paymentStatus: 'PENDING',
      createdAt: new Date().toISOString(),
    };
    return repo.createOrder(order);
  };

  it('successfully processes a valid payment webhook and transitions order to QUEUED with atomic job creation', async () => {
    await createTestOrder('ord_pay_1', 'P1001', 'AWAITING_PAYMENT', 4800);

    const payload = {
      orderId: 'ord_pay_1',
      paymentId: 'pay_tx_9999',
      amountPaisa: 4800,
      status: 'SUCCESS',
    };

    const req = new NextRequest('http://localhost:3000/api/webhooks/payment', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.status).toBe('QUEUED');
    expect(data.jobId).toBeDefined();

    // Verify order state in repository
    const updatedOrder = await repo.getOrder('ord_pay_1');
    expect(updatedOrder?.status).toBe('QUEUED');
    expect(updatedOrder?.paymentStatus).toBe('PAID');

    // Verify single atomic print job created
    const job = await repo.getJobByOrderId('ord_pay_1');
    expect(job).toBeDefined();
    expect(job?.status).toBe('QUEUED');

    // Verify payment transaction recorded
    const events = await repo.getOrderEvents('ord_pay_1');
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('guarantees idempotency on duplicate webhook deliveries without creating duplicate jobs', async () => {
    await createTestOrder('ord_pay_2', 'P1002', 'AWAITING_PAYMENT', 2500);

    const payload = {
      orderId: 'ord_pay_2',
      paymentId: 'pay_tx_duplicate_1',
      amountPaisa: 2500,
      status: 'SUCCESS',
    };

    const makeRequest = () =>
      new NextRequest('http://localhost:3000/api/webhooks/payment', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      });

    // First delivery
    const res1 = await POST(makeRequest());
    expect(res1.status).toBe(200);
    const data1 = await res1.json();
    expect(data1.status).toBe('QUEUED');

    // Duplicate delivery
    const res2 = await POST(makeRequest());
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.isDuplicate).toBe(true);

    // Assert that only exactly 1 print job exists for this order
    const jobs = await repo.listJobs();
    const orderJobs = jobs.filter((j) => j.orderId === 'ord_pay_2');
    expect(orderJobs.length).toBe(1);
  });

  it('rejects tampered payment amounts that do not match the expected order total in paisa', async () => {
    await createTestOrder('ord_pay_3', 'P1003', 'AWAITING_PAYMENT', 4800);

    // Tampered payload with amount: 100 paisa instead of 4800 paisa
    const payload = {
      orderId: 'ord_pay_3',
      paymentId: 'pay_tx_tampered',
      amountPaisa: 100,
      status: 'SUCCESS',
    };

    const req = new NextRequest('http://localhost:3000/api/webhooks/payment', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toContain('Payment amount mismatch');

    // Order should remain AWAITING_PAYMENT
    const order = await repo.getOrder('ord_pay_3');
    expect(order?.status).toBe('AWAITING_PAYMENT');
    expect(order?.paymentStatus).toBe('PENDING');

    // No print jobs should have been created
    const job = await repo.getJobByOrderId('ord_pay_3');
    expect(job).toBeNull();
  });

  it('returns 404 when payment webhook references a non-existent order', async () => {
    const payload = {
      orderId: 'non_existent_order_id',
      paymentId: 'pay_tx_404',
      amountPaisa: 1000,
      status: 'SUCCESS',
    };

    const req = new NextRequest('http://localhost:3000/api/webhooks/payment', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('handles payment on cancelled order by transitioning to REFUND_PENDING', async () => {
    await createTestOrder('ord_pay_cancelled', 'P1004', 'CANCELLED', 3000);

    const payload = {
      orderId: 'ord_pay_cancelled',
      paymentId: 'pay_tx_cancel_refund',
      amountPaisa: 3000,
      status: 'SUCCESS',
    };

    const req = new NextRequest('http://localhost:3000/api/webhooks/payment', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('REFUND_PENDING');
  });
});
