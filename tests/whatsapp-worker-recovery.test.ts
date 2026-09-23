import { describe, it, expect, beforeEach, vi } from 'vitest';
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

    it('processes 30-page PDF AI(UN-05).pdf via OpenWA data.body data-URL payload without errors', async () => {
      const pdfDoc = await PDFDocument.create();
      for (let i = 0; i < 30; i++) {
        const page = pdfDoc.addPage([595, 842]);
        page.drawText(`AI(UN-05) Page ${i + 1}`);
      }
      const pdfBytes = await pdfDoc.save();
      const base64Data = Buffer.from(pdfBytes).toString('base64');
      const dataUrl = `data:application/pdf;base64,${base64Data}`;

      // Simulate real-world OpenWA webhook payload format for AI(UN-05).pdf
      await repo.enqueueInboxItem({
        messageId: 'false_918080750206@c.us_3EB0AIUN05_TEST',
        senderPhone: '918080750206',
        rawPayload: {
          event: 'message',
          sessionId: 'session-printos',
          data: {
            id: 'false_918080750206@c.us_3EB0AIUN05_TEST',
            from: '918080750206@c.us',
            type: 'document',
            body: dataUrl,
            mimetype: 'application/pdf',
            filename: 'AI(UN-05).pdf',
            hasMedia: true,
          },
        },
      });

      const engine = new WhatsAppWorkerEngine(repo);
      await engine.runCycle(10, 120);

      // Verify conversation
      const conv = await repo.getConversation('918080750206');
      expect(conv).toBeDefined();
      expect(conv?.currentState).toBe('COLLECTING_COLOR');
      expect(conv?.sessionData?.originalFilename).toBe('AI_UN-05_.pdf');
      expect(conv?.sessionData?.pageCount).toBe(30);

      // Verify outbox messages
      const outboxItems = Array.from((repo as any).outbox.values()) as any[];
      const errItem = outboxItems.find((o) => (o.payload?.idempotencyKey || '').startsWith('media_err_'));
      expect(errItem).toBeUndefined(); // No media ingestion error

      const ackItem = outboxItems.find((o) => (o.payload?.idempotencyKey || '').startsWith('ack_'));
      expect(ackItem).toBeDefined();
      expect(ackItem.payload?.body).toContain('Document received. Processing your file now...');

      // Verify prompt message sent to customer
      expect(mockProvider.sentMessages.length).toBe(2);
      expect(mockProvider.sentMessages[0].message).toContain('Document received. Processing your file now...');
      expect(mockProvider.sentMessages[1].message).toContain('30 pages');
    });

    it('processes real production omitted-media payload for AI(UN-06).pdf (35 pages) via download stream', async () => {
      const pdfDoc = await PDFDocument.create();
      for (let i = 0; i < 35; i++) {
        const page = pdfDoc.addPage([595, 842]);
        page.drawText(`AI(UN-06) Page ${i + 1}`);
      }
      const pdfBytes = await pdfDoc.save();
      const pdfBuffer = Buffer.from(pdfBytes);

      let downloadStreamCalled = false;
      const customProvider = {
        sendText: vi.fn().mockResolvedValue({ providerMessageId: 'msg_txt' }),
        sendInteractiveButtons: vi.fn().mockResolvedValue({ providerMessageId: 'msg_btn' }),
        sendDocument: vi.fn().mockResolvedValue({ providerMessageId: 'msg_doc' }),
        getMediaUrl: vi.fn().mockResolvedValue({
          url: 'http://127.0.0.1:2785/api/sessions/session-printos/messages/20495684599884@lid/msg_35pages/media',
          mimeType: 'application/pdf',
        }),
        downloadMediaStream: vi.fn().mockImplementation(async () => {
          downloadStreamCalled = true;
          const { Readable } = await import('stream');
          return {
            stream: Readable.from([pdfBuffer]),
            contentLength: pdfBuffer.length,
          };
        }),
      };
      setWhatsAppProvider(customProvider as any);

      // Exact production payload structure where body is filename and media.omitted is true
      await repo.enqueueInboxItem({
        messageId: 'false_20495684599884@lid_AC79B8926BA9D762CC11E793A8B95332',
        senderPhone: '20495684599884@lid',
        rawPayload: {
          event: 'message.received',
          sessionId: 'session-printos',
          data: {
            id: 'false_20495684599884@lid_AC79B8926BA9D762CC11E793A8B95332',
            to: '918080750206@c.us',
            from: '20495684599884@lid',
            chatId: '20495684599884@lid',
            type: 'document',
            body: 'AI(UN-06).pdf', // Filename in body, NOT base64!
            fromMe: false,
            media: {
              omitted: true,
              filename: 'AI(UN-06).pdf',
              mimetype: 'application/pdf',
              sizeBytes: 891847,
            },
          },
        },
      });

      const engine = new WhatsAppWorkerEngine(repo);
      await engine.runCycle(10, 120);

      // Verify downloadMediaStream was invoked
      expect(downloadStreamCalled).toBe(true);
      expect(customProvider.getMediaUrl).toHaveBeenCalled();

      // Verify conversation state and true 35 page count
      const conv = await repo.getConversation('20495684599884@lid');
      expect(conv).toBeDefined();
      expect(conv?.currentState).toBe('COLLECTING_COLOR');
      expect(conv?.sessionData?.originalFilename).toBe('AI_UN-06_.pdf');
      expect(conv?.sessionData?.pageCount).toBe(35);

      // Verify no error message was sent
      const outboxItems = Array.from((repo as any).outbox.values()) as any[];
      const errItem = outboxItems.find((o) => (o.payload?.idempotencyKey || '').startsWith('media_err_'));
      expect(errItem).toBeUndefined();

      // Verify ack and button prompt were sent
      expect(customProvider.sendText).toHaveBeenCalled();
      expect(customProvider.sendInteractiveButtons).toHaveBeenCalled();
      const promptCall = customProvider.sendInteractiveButtons.mock.calls[0];
      expect(promptCall[1]).toContain('35 pages');
    });

    it('does NOT treat plain filenames (document.pdf, photo.jpg, AI(UN-05).pdf) as inline base64', async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage([595, 842]);
      const pdfBuffer = Buffer.from(await pdfDoc.save());

      const filenames = ['document.pdf', 'photo.jpg', 'AI(UN-05).pdf'];

      for (let i = 0; i < filenames.length; i++) {
        const fname = filenames[i];
        const msgId = `msg_filename_safety_${i}`;
        let streamCalled = false;

        const mockP = {
          sendText: vi.fn().mockResolvedValue({ providerMessageId: 'm1' }),
          sendInteractiveButtons: vi.fn().mockResolvedValue({ providerMessageId: 'm2' }),
          sendDocument: vi.fn().mockResolvedValue({ providerMessageId: 'm3' }),
          getMediaUrl: vi.fn().mockResolvedValue({
            url: `http://mock/media/${fname}`,
            mimeType: 'application/pdf',
          }),
          downloadMediaStream: vi.fn().mockImplementation(async () => {
            streamCalled = true;
            const { Readable } = await import('stream');
            return { stream: Readable.from([pdfBuffer]), contentLength: pdfBuffer.length };
          }),
        };
        setWhatsAppProvider(mockP as any);

        const subRepo = new InMemoryPrintOSRepository();
        await subRepo.enqueueInboxItem({
          messageId: msgId,
          senderPhone: `91987654321${i}`,
          rawPayload: {
            event: 'message',
            sessionId: 'session-printos',
            data: {
              id: msgId,
              from: `91987654321${i}@c.us`,
              chatId: `91987654321${i}@c.us`,
              type: 'document',
              body: fname, // plain filename string
              media: {
                omitted: true,
                filename: fname,
                mimetype: 'application/pdf',
              },
            },
          },
        });

        const engine = new WhatsAppWorkerEngine(subRepo);
        await engine.runCycle(10, 120);

        // Must invoke streaming download because body is just a filename
        expect(streamCalled).toBe(true);
        expect(mockP.downloadMediaStream).toHaveBeenCalled();
      }
    });

    it('correctly treats data:application/pdf;base64,... as inline media without calling download stream', async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage([595, 842]);
      const pdfBytes = await pdfDoc.save();
      const dataUrl = `data:application/pdf;base64,${Buffer.from(pdfBytes).toString('base64')}`;

      const mockP = {
        sendText: vi.fn().mockResolvedValue({ providerMessageId: 'm1' }),
        sendInteractiveButtons: vi.fn().mockResolvedValue({ providerMessageId: 'm2' }),
        sendDocument: vi.fn().mockResolvedValue({ providerMessageId: 'm3' }),
        getMediaUrl: vi.fn(),
        downloadMediaStream: vi.fn(),
      };
      setWhatsAppProvider(mockP as any);

      const subRepo = new InMemoryPrintOSRepository();
      await subRepo.enqueueInboxItem({
        messageId: 'msg_inline_data_url',
        senderPhone: '919876543200',
        rawPayload: {
          event: 'message',
          sessionId: 'session-printos',
          data: {
            id: 'msg_inline_data_url',
            from: '919876543200@c.us',
            chatId: '919876543200@c.us',
            type: 'document',
            body: dataUrl,
            filename: 'inline.pdf',
            hasMedia: true,
          },
        },
      });

      const engine = new WhatsAppWorkerEngine(subRepo);
      await engine.runCycle(10, 120);

      // Download stream should NOT be called since valid data URL was provided inline
      expect(mockP.downloadMediaStream).not.toHaveBeenCalled();

      const conv = await subRepo.getConversation('919876543200');
      expect(conv?.currentState).toBe('COLLECTING_COLOR');
      expect(conv?.sessionData?.pageCount).toBe(1);
    });
  });
});
