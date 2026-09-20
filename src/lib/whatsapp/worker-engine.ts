import crypto from 'crypto';
import { IPrintOSRepository } from '@/lib/repository';
import { WhatsAppInboxItem, WhatsAppOutboxItem, InboundWhatsAppEvent } from '@/types/whatsapp';
import { WhatsAppStateMachine } from './state-machine';
import { WhatsAppMediaDownloader } from './media-downloader';
import { getWhatsAppProvider } from './provider';

export interface WorkerBatchResult {
  workerId: string;
  inboxClaimed: number;
  inboxProcessed: number;
  inboxFailed: number;
  inboxDeadLetter: number;
  outboxClaimed: number;
  outboxSent: number;
  outboxFailed: number;
  outboxDeadLetter: number;
  durationMs: number;
}

export class WhatsAppWorkerEngine {
  private repo: IPrintOSRepository;
  private mediaDownloader: WhatsAppMediaDownloader;

  constructor(repo: IPrintOSRepository) {
    this.repo = repo;
    this.mediaDownloader = new WhatsAppMediaDownloader();
  }

  /**
   * Main entrypoint for processing both inbox and outbox queues in a single run.
   */
  public async runCycle(
    batchSize = 10,
    leaseSeconds = 120
  ): Promise<WorkerBatchResult> {
    const startTime = Date.now();
    const workerId = `worker_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const inboxRes = await this.processInboxQueue(workerId, batchSize, leaseSeconds);
    const outboxRes = await this.processOutboxQueue(workerId, batchSize, leaseSeconds);

    return {
      workerId,
      inboxClaimed: inboxRes.claimed,
      inboxProcessed: inboxRes.processed,
      inboxFailed: inboxRes.failed,
      inboxDeadLetter: inboxRes.deadLetter,
      outboxClaimed: outboxRes.claimed,
      outboxSent: outboxRes.sent,
      outboxFailed: outboxRes.failed,
      outboxDeadLetter: outboxRes.deadLetter,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Phase 1: Claim and process inbox messages with lease safety & heartbeat renewal.
   */
  public async processInboxQueue(
    workerId: string,
    batchSize = 10,
    leaseSeconds = 120
  ): Promise<{ claimed: number; processed: number; failed: number; deadLetter: number }> {
    const items = await this.repo.claimInboxBatch(workerId, batchSize, leaseSeconds);
    let processed = 0;
    let failed = 0;
    let deadLetter = 0;

    for (const item of items) {
      // Set up heartbeat timer for lease renewal during long-running tasks
      const heartbeatIntervalMs = Math.max(15000, Math.floor((leaseSeconds * 1000) / 3));
      let heartbeatTimer: NodeJS.Timeout | null = null;

      try {
        heartbeatTimer = setInterval(async () => {
          try {
            await this.repo.renewInboxLease(item.id, workerId, leaseSeconds);
          } catch (renewErr) {
            console.warn(`[Worker ${workerId}] Failed to renew lease for inbox ${item.id}:`, renewErr);
          }
        }, heartbeatIntervalMs);

        await this.processSingleInboxItem(item, workerId);

        // Ownership verification happens in repository.completeInboxItem
        const ok = await this.repo.completeInboxItem(item.id, workerId);
        if (ok) {
          processed++;
        } else {
          // Lease was stolen/expired
          console.warn(`[Worker ${workerId}] Unable to mark inbox ${item.id} processed; lease likely reclaimed.`);
          failed++;
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Worker ${workerId}] Error processing inbox ${item.id}:`, errorMsg);

        const newAttempts = item.attemptCount + 1;
        if (newAttempts >= item.maxAttempts) {
          await this.repo.failInboxItem(item.id, workerId, errorMsg, false);
          deadLetter++;
        } else {
          await this.repo.failInboxItem(item.id, workerId, errorMsg, true);
          failed++;
        }
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
      }
    }

    return { claimed: items.length, processed, failed, deadLetter };
  }

  /**
   * Phase 2: Claim and transmit outbox messages with lease safety.
   */
  public async processOutboxQueue(
    workerId: string,
    batchSize = 10,
    leaseSeconds = 120
  ): Promise<{ claimed: number; sent: number; failed: number; deadLetter: number }> {
    const items = await this.repo.claimOutboxBatch(workerId, batchSize, leaseSeconds);
    let sent = 0;
    let failed = 0;
    let deadLetter = 0;
    const provider = getWhatsAppProvider();

    for (const item of items) {
      let heartbeatTimer: NodeJS.Timeout | null = null;
      const heartbeatIntervalMs = Math.max(15000, Math.floor((leaseSeconds * 1000) / 3));

      try {
        heartbeatTimer = setInterval(async () => {
          try {
            await this.repo.renewOutboxLease(item.id, workerId, leaseSeconds);
          } catch (renewErr) {
            console.warn(`[Worker ${workerId}] Failed to renew lease for outbox ${item.id}:`, renewErr);
          }
        }, heartbeatIntervalMs);

        const providerMessageId = await this.transmitOutboxItem(item, provider);

        // Mark sent verifying current lease ownership
        const ok = await this.repo.completeOutboxItem(item.id, workerId, providerMessageId);
        if (ok) {
          sent++;
        } else {
          console.warn(`[Worker ${workerId}] Unable to mark outbox ${item.id} sent; lease likely expired.`);
          failed++;
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Worker ${workerId}] Error sending outbox ${item.id}:`, errorMsg);

        const newAttempts = item.attemptCount + 1;
        if (newAttempts >= item.maxAttempts) {
          await this.repo.failOutboxItem(item.id, workerId, errorMsg);
          deadLetter++;
        } else {
          await this.repo.failOutboxItem(item.id, workerId, errorMsg);
          failed++;
        }
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
      }
    }

    return { claimed: items.length, sent, failed, deadLetter };
  }

  private async processSingleInboxItem(item: WhatsAppInboxItem, _workerId: string): Promise<void> {
    const rawPayload = item.rawPayload;
    const event: InboundWhatsAppEvent = {
      wamid: item.messageId,
      from: item.senderPhone,
      timestamp: Date.now(),
      type: (rawPayload.type as InboundWhatsAppEvent['type']) || 'text',
      text: (rawPayload.text as string) || undefined,
      buttonId: (rawPayload.buttonId as string) || undefined,
      mediaId: (rawPayload.mediaId as string) || undefined,
      mimeType: (rawPayload.mimeType as string) || undefined,
      filename: (rawPayload.filename as string) || undefined,
      fileSize: (rawPayload.fileSize as number) || undefined,
      rawPayload,
    };

    // If inbound event contains media, ingest and validate magic-bytes
    if (event.mediaId && (event.type === 'document' || event.type === 'image')) {
      const provider = getWhatsAppProvider();
      const inlineBase64 =
        (rawPayload?.data as any)?.media?.data ||
        (rawPayload?.media as any)?.data ||
        (rawPayload?.inlineBase64 as string);

      const ingested = await this.mediaDownloader.ingestMedia(
        provider,
        event.mediaId,
        event.filename,
        item.senderPhone,
        typeof inlineBase64 === 'string' ? inlineBase64 : undefined
      );

      // Attach ingested metadata to event for state machine
      event.filename = ingested.filename;
      event.mimeType = ingested.mimeType;
      event.fileSize = ingested.fileSizeBytes;
      event.rawPayload.storagePath = ingested.storagePath;
      event.rawPayload.pageCount = ingested.pageCount;
      event.rawPayload.fileType = ingested.fileType;
    }

    // Advance conversation state machine
    await WhatsAppStateMachine.processEvent(event, this.repo, item.shopId || undefined);
  }

  private async transmitOutboxItem(
    item: WhatsAppOutboxItem,
    provider: ReturnType<typeof getWhatsAppProvider>
  ): Promise<string> {
    const { payload, recipientPhone, messageType } = item;

    if (messageType === 'text') {
      const res = await provider.sendText(recipientPhone, payload.text || payload.body || '');
      return res.providerMessageId;
    }

    if (messageType === 'interactive') {
      const res = await provider.sendInteractiveButtons(
        recipientPhone,
        payload.text || payload.body || '',
        payload.buttons || [],
        payload.headerText,
        payload.footerText
      );
      return res.providerMessageId;
    }

    if (messageType === 'document') {
      const res = await provider.sendDocument(
        recipientPhone,
        payload.documentUrl || payload.mediaUrl || '',
        payload.filename || 'document.pdf',
        payload.caption
      );
      return res.providerMessageId;
    }

    // Default text fallback
    const res = await provider.sendText(recipientPhone, payload.text || payload.body || '');
    return res.providerMessageId;
  }
}
