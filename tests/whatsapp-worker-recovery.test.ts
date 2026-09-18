import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryPrintOSRepository } from '@/lib/repository/in-memory-repository';
import { WhatsAppWorkerEngine } from '@/lib/whatsapp/worker-engine';
import { setWhatsAppProvider } from '@/lib/whatsapp/provider';
import { MockWhatsAppProvider } from '@/lib/whatsapp/provider/mock-whatsapp-provider';

describe('Phase 2: WhatsApp Worker Recovery, Lease Expiration & Concurrency Safety', () => {
  let repo: InMemoryPrintOSRepository;
  let mockProvider: MockWhatsAppProvider;

  beforeEach(() => {
    repo = new InMemoryPrintOSRepository();
    mockProvider = new MockWhatsAppProvider();
    setWhatsAppProvider(mockProvider);
  });

  it('prevents two concurrent workers from claiming the same inbox item', async () => {
    // Enqueue 1 item
    await repo.enqueueInboxItem({
      messageId: 'wamid_concurrent_1',
      senderPhone: '919876543210',
      rawPayload: { type: 'text', text: 'hi' },
    });

    const worker1 = 'worker_alpha';
    const worker2 = 'worker_beta';

    // Worker 1 claims
    const claim1 = await repo.claimInboxBatch(worker1, 10, 120);
    expect(claim1.length).toBe(1);
    expect(claim1[0].workerId).toBe(worker1);

    // Worker 2 attempts to claim simultaneously
    const claim2 = await repo.claimInboxBatch(worker2, 10, 120);
    expect(claim2.length).toBe(0); // Row is locked by worker 1
  });

  it('allows reclaim of an inbox row after its lease expires', async () => {
    const { item } = await repo.enqueueInboxItem({
      messageId: 'wamid_expired_lease_1',
      senderPhone: '919876543210',
      rawPayload: { type: 'text', text: 'hi' },
    });

    const worker1 = 'worker_crashed';
    const worker2 = 'worker_recovery';

    // Worker 1 claims with 1 second lease
    const claim1 = await repo.claimInboxBatch(worker1, 10, 1);
    expect(claim1.length).toBe(1);

    // Simulate time passing (backdate locked_until)
    const rawItem = (repo as any).inbox.get(item.id);
    rawItem.lockedUntil = new Date(Date.now() - 5000).toISOString(); // 5 seconds in the past

    // Worker 2 attempts to claim -> should successfully reclaim the expired lease
    const claim2 = await repo.claimInboxBatch(worker2, 10, 120);
    expect(claim2.length).toBe(1);
    expect(claim2[0].id).toBe(item.id);
    expect(claim2[0].workerId).toBe(worker2);
  });

  it('rejects completion from a non-owner worker or an expired owner after reclaim', async () => {
    const { item } = await repo.enqueueInboxItem({
      messageId: 'wamid_stolen_lease_1',
      senderPhone: '919876543210',
      rawPayload: { type: 'text', text: 'hi' },
    });

    const worker1 = 'worker_slow';
    const worker2 = 'worker_fast';

    // Worker 1 claims
    await repo.claimInboxBatch(worker1, 10, 1);

    // Expire Worker 1's lease
    const rawItem = (repo as any).inbox.get(item.id);
    rawItem.lockedUntil = new Date(Date.now() - 5000).toISOString();

    // Worker 2 reclaims and completes
    await repo.claimInboxBatch(worker2, 10, 120);
    const complete2 = await repo.completeInboxItem(item.id, worker2);
    expect(complete2).toBe(true);

    // Worker 1 (which woke up late) attempts to complete -> REJECTED
    const complete1 = await repo.completeInboxItem(item.id, worker1);
    expect(complete1).toBe(false);
  });

  it('maintains ownership when active heartbeat renews lease', async () => {
    const { item } = await repo.enqueueInboxItem({
      messageId: 'wamid_renew_test',
      senderPhone: '919876543210',
      rawPayload: { type: 'text', text: 'long running processing' },
    });

    const worker1 = 'worker_active';
    await repo.claimInboxBatch(worker1, 10, 30);

    // Renew lease
    const renewed = await repo.renewInboxLease(item.id, worker1, 120);
    expect(renewed).toBe(true);

    const rawItem = (repo as any).inbox.get(item.id);
    const newLockTime = new Date(rawItem.lockedUntil).getTime();
    expect(newLockTime).toBeGreaterThan(Date.now() + 60000);
  });

  it('moves failed inbox items to DEAD_LETTER after 5 failed attempts', async () => {
    const { item } = await repo.enqueueInboxItem({
      messageId: 'wamid_fail_5x',
      senderPhone: '919876543210',
      rawPayload: { type: 'text', text: 'corrupted' },
    });

    const worker = 'worker_deadletter_test';

    // Simulate 4 retryable failures
    for (let i = 1; i <= 4; i++) {
      const claimed = await repo.claimInboxBatch(worker, 10, 120);
      expect(claimed.length).toBe(1);
      await repo.failInboxItem(item.id, worker, `Error attempt ${i}`, true);
    }

    // 5th failure -> marks DEAD_LETTER
    const claimed5 = await repo.claimInboxBatch(worker, 10, 120);
    expect(claimed5.length).toBe(1);
    await repo.failInboxItem(item.id, worker, 'Final critical failure', false);

    const finalItem = (repo as any).inbox.get(item.id);
    expect(finalItem.status).toBe('DEAD_LETTER');
    expect(finalItem.attemptCount).toBe(5);

    // Should no longer be claimable by normal queue
    const nextClaim = await repo.claimInboxBatch(worker, 10, 120);
    expect(nextClaim.length).toBe(0);
  });

  it('processes outbox items and enforces at-least-once external transmission', async () => {
    await repo.enqueueOutboxItem({
      recipientPhone: '919876543210',
      messageType: 'text',
      payload: { text: 'Test Outbox Message' },
    });

    const engine = new WhatsAppWorkerEngine(repo);
    const result = await engine.processOutboxQueue('worker_outbox_1', 10, 120);

    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    expect(mockProvider.sentMessages.length).toBe(1);
    expect(mockProvider.sentMessages[0].message).toBe('Test Outbox Message');
  });
});
