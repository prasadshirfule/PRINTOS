import { describe, it, expect, beforeEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
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

  describe('Inbound Media Processing & Immediate Acknowledgement', () => {
    it('enqueues immediate acknowledgement BEFORE expensive media processing starts', async () => {
      let ackEnqueuedBeforeIngest = false;

      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage([595, 842]);
      const samplePdfBase64 = Buffer.from(await pdfDoc.save()).toString('base64');

      await repo.enqueueInboxItem({
        messageId: 'wamid_media_order_test',
        senderPhone: '919876543210',
        rawPayload: {
          type: 'document',
          mediaId: 'media_long_pdf_1',
          filename: 'thesis_long.pdf',
          mimeType: 'application/pdf',
          data: {
            media: {
              data: samplePdfBase64,
            },
          },
        },
      });

      const engine = new WhatsAppWorkerEngine(repo);

      // Spy on ingestMedia to check outbox state at the moment ingest starts
      const origIngest = (engine as any).mediaDownloader.ingestMedia.bind((engine as any).mediaDownloader);
      (engine as any).mediaDownloader.ingestMedia = async (...args: any[]) => {
        const outboxItems = Array.from((repo as any).outbox.values()) as any[];
        const ack = outboxItems.find((o: any) => o.payload?.idempotencyKey === 'ack_wamid_media_order_test');
        if (ack && ack.payload?.body?.includes('Document received. Processing your file now...')) {
          ackEnqueuedBeforeIngest = true;
        }
        return origIngest(...args);
      };

      await engine.processInboxQueue('worker_test', 10, 120);

      expect(ackEnqueuedBeforeIngest).toBe(true);

      // Verify acknowledgement outbox item exists
      const outboxItems = Array.from((repo as any).outbox.values()) as any[];
      const ackItem = outboxItems.find((o) => o.payload?.idempotencyKey === 'ack_wamid_media_order_test');
      expect(ackItem).toBeDefined();
      expect(ackItem?.payload?.body).toContain('Document received. Processing your file now...');
    });

    it('persists acknowledgement and creates customer-safe error message when media ingestion fails', async () => {
      // Malformed/invalid magic-bytes payload (not a valid PDF or image)
      const invalidBase64 = Buffer.from('NOT_A_VALID_PDF_OR_IMAGE_DATA').toString('base64');

      const { item } = await repo.enqueueInboxItem({
        messageId: 'wamid_invalid_media_1',
        senderPhone: '919876543210',
        rawPayload: {
          type: 'document',
          mediaId: 'media_invalid_1',
          filename: 'corrupted.pdf',
          mimeType: 'application/pdf',
          data: {
            media: {
              data: invalidBase64,
            },
          },
        },
      });

      const engine = new WhatsAppWorkerEngine(repo);
      await engine.processInboxQueue('worker_test', 10, 120);

      const outboxItems = Array.from((repo as any).outbox.values()) as any[];

      // 1. Acknowledgement must still be persisted
      const ackItem = outboxItems.find((o) => o.payload?.idempotencyKey === 'ack_wamid_invalid_media_1');
      expect(ackItem).toBeDefined();

      // 2. Customer-safe error message must be enqueued with media_err_<messageId>
      const errItem = outboxItems.find((o) => o.payload?.idempotencyKey === 'media_err_wamid_invalid_media_1');
      expect(errItem).toBeDefined();
      expect(errItem?.payload?.body).toContain('⚠️');
      expect(errItem?.payload?.body).not.toContain('stack');
      expect(errItem?.payload?.body).not.toContain('Error:');

      // 3. Inbox item was marked failed with attempt count incremented
      const rawInbox = (repo as any).inbox.get(item.id);
      expect(rawInbox.attemptCount).toBe(1);
    });

    it('deduplicates acknowledgement when the same inbound message is retried', async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage([595, 842]);
      const samplePdfBase64 = Buffer.from(await pdfDoc.save()).toString('base64');

      await repo.enqueueInboxItem({
        messageId: 'wamid_retry_ack_test',
        senderPhone: '919876543210',
        rawPayload: {
          type: 'document',
          mediaId: 'media_retry_1',
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          data: {
            media: {
              data: samplePdfBase64,
            },
          },
        },
      });

      const engine = new WhatsAppWorkerEngine(repo);

      // Process once
      await engine.processInboxQueue('worker_test', 10, 120);

      // Count acks in outbox
      let outboxItems = Array.from((repo as any).outbox.values()) as any[];
      let acks = outboxItems.filter((o) => o.payload?.idempotencyKey === 'ack_wamid_retry_ack_test');
      expect(acks.length).toBe(1);

      // Simulate re-processing / retry of same inbox item
      const item = Array.from((repo as any).inbox.values())[0] as any;
      item.status = 'PENDING';
      item.workerId = null;

      await engine.processInboxQueue('worker_test_2', 10, 120);

      // Should still only have 1 ack item due to idempotencyKey
      outboxItems = Array.from((repo as any).outbox.values()) as any[];
      acks = outboxItems.filter((o) => o.payload?.idempotencyKey === 'ack_wamid_retry_ack_test');
      expect(acks.length).toBe(1);
    });

    it('successfully transitions to COLLECTING_COLOR and preserves page count after media ingestion', async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage([595, 842]);
      pdfDoc.addPage([595, 842]);
      const samplePdfBase64 = Buffer.from(await pdfDoc.save()).toString('base64');

      await repo.enqueueInboxItem({
        messageId: 'wamid_valid_pdf_flow',
        senderPhone: '919876543210',
        rawPayload: {
          type: 'document',
          mediaId: 'media_valid_pdf',
          filename: 'project_final.pdf',
          mimeType: 'application/pdf',
          data: {
            media: {
              data: samplePdfBase64,
            },
          },
        },
      });

      const engine = new WhatsAppWorkerEngine(repo);
      await engine.runCycle(10, 120);

      // Check conversation state
      const conv = await repo.getConversation('919876543210');
      expect(conv).toBeDefined();
      expect(conv?.currentState).toBe('COLLECTING_COLOR');
      expect(conv?.sessionData?.originalFilename).toContain('project_final.pdf');
      expect(conv?.sessionData?.pageCount).toBe(2);

      // Check sent messages from outbox
      expect(mockProvider.sentMessages.length).toBeGreaterThanOrEqual(2);
      // 1st message: Ack
      expect(mockProvider.sentMessages[0].message).toContain('Document received. Processing your file now...');
      // 2nd message: Configuration prompt with buttons
      expect(mockProvider.sentMessages[1].message).toContain('Received *project_final.pdf* (2 pages)');
    });
  });
});
