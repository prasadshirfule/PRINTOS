import { describe, it, expect, beforeEach } from 'vitest';
import { globalStore } from '@/lib/db/store';
import { PrintOrder } from '@/types/printos';

describe('Mock Print Agent Failure & Retry Simulation', () => {
  beforeEach(() => {
    globalStore.clear();
  });

  it('simulates hardware failure through the Mock Agent and verifies controlled retry limit', async () => {
    const orderId = 'order-fail-test';
    const order: PrintOrder = {
      id: orderId,
      orderNumber: 'P9999',
      customerPhone: '919876543210',
      status: 'AWAITING_PAYMENT',
      originalFilename: 'test.pdf',
      storagePath: `orders/${orderId}/test.pdf`,
      fileType: 'pdf',
      fileSize: 1024,
      pageCount: 1,
      paperSize: 'A4',
      colorMode: 'BW',
      printSides: 'ONE_SIDED',
      copies: 1,
      selectedPageCount: 1,
      subtotalPaisa: 200,
      discountPaisa: 0,
      totalAmountPaisa: 200,
      currency: 'INR',
      paymentStatus: 'PENDING',
      createdAt: new Date().toISOString(),
    };
    globalStore.createOrder(order);
    const { job } = globalStore.simulateVerifiedPayment(orderId, 'tx_fail_001');

    // Attempt 1: Agent claims, encounters paper jam, reports FAILED
    const claim1 = await globalStore.claimNextPrintJob('mock-agent-fail');
    expect(claim1).not.toBeNull();
    globalStore.updateJobStatus(job.id, { status: 'FAILED', errorMessage: 'Simulated paper jam' });

    let currentJob = globalStore.getJob(job.id);
    expect(currentJob?.status).toBe('RETRY_PENDING');
    expect(currentJob?.attemptCount).toBe(1);

    // Attempt 2: Re-claimed and fails again
    const claim2 = await globalStore.claimNextPrintJob('mock-agent-fail');
    expect(claim2).not.toBeNull();
    globalStore.updateJobStatus(job.id, { status: 'FAILED', errorMessage: 'Simulated ink empty' });

    currentJob = globalStore.getJob(job.id);
    expect(currentJob?.status).toBe('RETRY_PENDING');
    expect(currentJob?.attemptCount).toBe(2);

    // Attempt 3: Re-claimed and fails (reaches maxAttempts = 3)
    const claim3 = await globalStore.claimNextPrintJob('mock-agent-fail');
    expect(claim3).not.toBeNull();
    globalStore.updateJobStatus(job.id, { status: 'FAILED', errorMessage: 'Hardware spooler failure' });

    currentJob = globalStore.getJob(job.id);
    const currentOrder = globalStore.getOrder(orderId);

    // Should now be terminal FAILED, no infinite retry
    expect(currentJob?.status).toBe('FAILED');
    expect(currentJob?.attemptCount).toBe(3);
    expect(currentOrder?.status).toBe('FAILED');

    // Attempt 4 should yield NO eligible jobs
    const claim4 = await globalStore.claimNextPrintJob('mock-agent-fail');
    expect(claim4).toBeNull();
  });
});
