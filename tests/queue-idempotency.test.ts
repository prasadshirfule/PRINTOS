import { describe, it, expect, beforeEach } from 'vitest';
import { globalStore } from '@/lib/db/store';
import { PrintOrder } from '@/types/printos';

describe('Print Queue & Payment Idempotency Engine', () => {
  beforeEach(() => {
    globalStore.clear();
  });

  function createTestOrder(id = 'order-test-1', orderNumber = 'P1001'): PrintOrder {
    const order: PrintOrder = {
      id,
      orderNumber,
      customerPhone: '919876543210',
      customerName: 'Test Student',
      status: 'AWAITING_PAYMENT',
      originalFilename: 'notes.pdf',
      storagePath: `orders/${id}/notes.pdf`,
      fileType: 'pdf',
      fileSize: 102400,
      pageCount: 5,
      paperSize: 'A4',
      colorMode: 'BW',
      printSides: 'BOTH_SIDES',
      copies: 2,
      pageSelection: '1-5',
      selectedPageCount: 5,
      subtotalPaisa: 2000,
      discountPaisa: 0,
      totalAmountPaisa: 2000,
      currency: 'INR',
      paymentStatus: 'PENDING',
      createdAt: new Date().toISOString(),
    };
    return globalStore.createOrder(order);
  }

  it('creates exactly ONE print job upon verified payment', () => {
    createTestOrder('order-1', 'P1001');

    const result = globalStore.simulateVerifiedPayment('order-1', 'tx_unique_001');
    expect(result.order.status).toBe('QUEUED');
    expect(result.order.paymentStatus).toBe('PAID');
    expect(result.job.status).toBe('QUEUED');
    expect(result.job.orderId).toBe('order-1');
    expect(result.isDuplicate).toBe(false);

    const jobs = globalStore.listJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].id).toBe(result.job.id);
  });

  it('enforces idempotency: duplicate webhook does NOT create a second print job', () => {
    createTestOrder('order-dup', 'P1002');

    // First webhook delivery
    const res1 = globalStore.simulateVerifiedPayment('order-dup', 'tx_webhook_999');
    expect(res1.isDuplicate).toBe(false);

    // Duplicate webhook delivery #2
    const res2 = globalStore.simulateVerifiedPayment('order-dup', 'tx_webhook_999');
    expect(res2.isDuplicate).toBe(true);
    expect(res2.job.id).toBe(res1.job.id);

    // Duplicate webhook delivery #3
    const res3 = globalStore.simulateVerifiedPayment('order-dup', 'tx_webhook_999');
    expect(res3.isDuplicate).toBe(true);

    // Assert only one job exists in database
    const jobs = globalStore.listJobs();
    expect(jobs.length).toBe(1);
  });

  it('prevents race conditions: only ONE agent can claim a given job', async () => {
    createTestOrder('order-race', 'P1003');
    globalStore.simulateVerifiedPayment('order-race', 'tx_race_001');

    // Simulate Agent A and Agent B attempting to claim simultaneously
    const agentAId = '00000000-0000-0000-0000-000000000002';
    const agentBId = '00000000-0000-0000-0000-000000000003';

    const [claimA, claimB] = await Promise.all([
      globalStore.claimNextPrintJob(agentAId),
      globalStore.claimNextPrintJob(agentBId),
    ]);

    // Exactly one agent gets the job, the other gets null
    const claimedCount = [claimA, claimB].filter(Boolean).length;
    expect(claimedCount).toBe(1);

    const successfulClaim = claimA || claimB;
    expect(successfulClaim?.orderNumber).toBe('P1003');

    // Job in store should now be CLAIMED
    const job = globalStore.getJob(successfulClaim!.jobId);
    expect(job?.status).toBe('CLAIMED');
  });

  it('transitions order and job through complete execution lifecycle', async () => {
    createTestOrder('order-lifecycle', 'P1004');
    const { job } = globalStore.simulateVerifiedPayment('order-lifecycle', 'tx_life_001');

    // Agent claims job
    const claim = await globalStore.claimNextPrintJob('agent-1');
    expect(claim).not.toBeNull();
    expect(claim?.jobId).toBe(job.id);

    // Order transitions to PRINTING
    let order = globalStore.getOrder('order-lifecycle');
    expect(order?.status).toBe('PRINTING');

    // Agent reports PRINTING
    globalStore.updateJobStatus(job.id, { status: 'PRINTING' });

    // Agent reports COMPLETED
    globalStore.updateJobStatus(job.id, { status: 'COMPLETED' });

    order = globalStore.getOrder('order-lifecycle');
    const updatedJob = globalStore.getJob(job.id);

    expect(updatedJob?.status).toBe('COMPLETED');
    expect(order?.status).toBe('COMPLETED');
    expect(order?.completedAt).toBeDefined();
  });

  it('handles safe retry logic on print failure without infinite retries', async () => {
    createTestOrder('order-retry', 'P1005');
    const { job } = globalStore.simulateVerifiedPayment('order-retry', 'tx_retry_001');

    // Attempt 1: Agent claims and fails
    await globalStore.claimNextPrintJob('agent-1');
    globalStore.updateJobStatus(job.id, { status: 'FAILED', errorMessage: 'Paper jam' });

    let updatedJob = globalStore.getJob(job.id);
    expect(updatedJob?.status).toBe('RETRY_PENDING'); // Queued for retry
    expect(updatedJob?.attemptCount).toBe(1);

    // Attempt 2: Claim and fail
    await globalStore.claimNextPrintJob('agent-1');
    globalStore.updateJobStatus(job.id, { status: 'FAILED', errorMessage: 'Out of paper' });
    updatedJob = globalStore.getJob(job.id);
    expect(updatedJob?.status).toBe('RETRY_PENDING');
    expect(updatedJob?.attemptCount).toBe(2);

    // Attempt 3: Claim and fail (hits maxAttempts = 3)
    await globalStore.claimNextPrintJob('agent-1');
    globalStore.updateJobStatus(job.id, { status: 'FAILED', errorMessage: 'Printer head error' });
    updatedJob = globalStore.getJob(job.id);
    const order = globalStore.getOrder('order-retry');

    expect(updatedJob?.status).toBe('FAILED');
    expect(updatedJob?.attemptCount).toBe(3);
    expect(order?.status).toBe('FAILED');
  });
});
