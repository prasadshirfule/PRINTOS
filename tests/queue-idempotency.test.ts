import { describe, it, expect, beforeEach } from 'vitest';
import { getRepository, UnauthorizedAgentJobError } from '@/lib/repository';
import { PrintOrder } from '@/types/printos';

describe('Print Queue & Payment Idempotency Engine', () => {
  const repo = getRepository();

  beforeEach(async () => {
    if (repo.clear) {
      await repo.clear();
    }
  });

  async function createTestOrder(id = 'order-test-1', orderNumber = 'P1001'): Promise<PrintOrder> {
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
    return await repo.createOrder(order);
  }

  it('creates exactly ONE print job upon verified payment', async () => {
    await createTestOrder('order-1', 'P1001');

    const result = await repo.simulateVerifiedPayment('order-1', 'tx_unique_001');
    expect(result.order.status).toBe('QUEUED');
    expect(result.order.paymentStatus).toBe('PAID');
    expect(result.job.status).toBe('QUEUED');
    expect(result.job.orderId).toBe('order-1');
    expect(result.isDuplicate).toBe(false);

    const jobs = await repo.listJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].id).toBe(result.job.id);
  });

  it('enforces idempotency: duplicate webhook does NOT create a second print job', async () => {
    await createTestOrder('order-dup', 'P1002');

    // First webhook delivery
    const res1 = await repo.simulateVerifiedPayment('order-dup', 'tx_webhook_999');
    expect(res1.isDuplicate).toBe(false);

    // Duplicate webhook delivery #2
    const res2 = await repo.simulateVerifiedPayment('order-dup', 'tx_webhook_999');
    expect(res2.isDuplicate).toBe(true);
    expect(res2.job.id).toBe(res1.job.id);

    // Duplicate webhook delivery #3
    const res3 = await repo.simulateVerifiedPayment('order-dup', 'tx_webhook_999');
    expect(res3.isDuplicate).toBe(true);

    const jobs = await repo.listJobs();
    expect(jobs.length).toBe(1);
  });

  it('prevents race conditions: only ONE agent can claim a given job', async () => {
    await createTestOrder('order-race', 'P1003');
    await repo.simulateVerifiedPayment('order-race', 'tx_race_001');

    const agentAId = '00000000-0000-0000-0000-000000000002';
    const agentBId = '00000000-0000-0000-0000-000000000003';

    const [claimA, claimB] = await Promise.all([
      repo.claimNextPrintJob(agentAId),
      repo.claimNextPrintJob(agentBId),
    ]);

    const claimedCount = [claimA, claimB].filter(Boolean).length;
    expect(claimedCount).toBe(1);

    const successfulClaim = claimA || claimB;
    expect(successfulClaim?.orderNumber).toBe('P1003');

    const job = await repo.getJob(successfulClaim!.jobId);
    expect(job?.status).toBe('CLAIMED');
  });

  it('enforces agent authorization: only the claiming agent can update the job', async () => {
    await createTestOrder('order-auth', 'P1003-auth');
    const { job } = await repo.simulateVerifiedPayment('order-auth', 'tx_auth_001');

    // Agent A claims job
    const agentA = 'agent-A-id';
    const agentB = 'agent-B-id';
    await repo.claimNextPrintJob(agentA);

    // Agent B attempts to update Agent A's job -> MUST FAIL with UnauthorizedAgentJobError
    await expect(
      repo.updateJobStatus(job.id, agentB, { status: 'COMPLETED' })
    ).rejects.toThrowError(UnauthorizedAgentJobError);

    // Agent A can update the job successfully
    const completedJob = await repo.updateJobStatus(job.id, agentA, { status: 'COMPLETED' });
    expect(completedJob.status).toBe('COMPLETED');
  });

  it('transitions order and job through complete execution lifecycle', async () => {
    await createTestOrder('order-lifecycle', 'P1004');
    const { job } = await repo.simulateVerifiedPayment('order-lifecycle', 'tx_life_001');

    const agentId = 'agent-1';
    const claim = await repo.claimNextPrintJob(agentId);
    expect(claim).not.toBeNull();
    expect(claim?.jobId).toBe(job.id);

    let order = await repo.getOrder('order-lifecycle');
    expect(order?.status).toBe('PRINTING');

    await repo.updateJobStatus(job.id, agentId, { status: 'PRINTING' });
    await repo.updateJobStatus(job.id, agentId, { status: 'COMPLETED' });

    order = await repo.getOrder('order-lifecycle');
    const updatedJob = await repo.getJob(job.id);

    expect(updatedJob?.status).toBe('COMPLETED');
    expect(order?.status).toBe('COMPLETED');
    expect(order?.completedAt).toBeDefined();
  });

  it('handles safe retry logic on print failure without infinite retries', async () => {
    await createTestOrder('order-retry', 'P1005');
    const { job } = await repo.simulateVerifiedPayment('order-retry', 'tx_retry_001');
    const agentId = 'agent-1';

    // Attempt 1: Agent claims and fails
    await repo.claimNextPrintJob(agentId);
    await repo.updateJobStatus(job.id, agentId, { status: 'FAILED', errorMessage: 'Paper jam' });

    let updatedJob = await repo.getJob(job.id);
    expect(updatedJob?.status).toBe('RETRY_PENDING');
    expect(updatedJob?.attemptCount).toBe(1);

    // Attempt 2: Claim and fail
    await repo.claimNextPrintJob(agentId);
    await repo.updateJobStatus(job.id, agentId, { status: 'FAILED', errorMessage: 'Out of paper' });
    updatedJob = await repo.getJob(job.id);
    expect(updatedJob?.status).toBe('RETRY_PENDING');
    expect(updatedJob?.attemptCount).toBe(2);

    // Attempt 3: Claim and fail (hits maxAttempts = 3)
    await repo.claimNextPrintJob(agentId);
    await repo.updateJobStatus(job.id, agentId, { status: 'FAILED', errorMessage: 'Printer head error' });
    updatedJob = await repo.getJob(job.id);
    const order = await repo.getOrder('order-retry');

    expect(updatedJob?.status).toBe('FAILED');
    expect(updatedJob?.attemptCount).toBe(3);
    expect(order?.status).toBe('FAILED');
  });
});