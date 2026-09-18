import { describe, it, expect, beforeEach } from 'vitest';
import { WhatsAppInboxService } from '@/lib/whatsapp/inbox-service';
import { InMemoryPrintOSRepository } from '@/lib/repository/in-memory-repository';
import { detectMagicBytes, WhatsAppMediaDownloader } from '@/lib/whatsapp/media-downloader';
import { MockWhatsAppProvider } from '@/lib/whatsapp/provider/mock-whatsapp-provider';
import { Readable } from 'stream';

describe('Phase 2: WhatsApp Webhook & Media Ingestion Pipeline', () => {
  let repo: InMemoryPrintOSRepository;
  let mockProvider: MockWhatsAppProvider;

  beforeEach(() => {
    repo = new InMemoryPrintOSRepository();
    mockProvider = new MockWhatsAppProvider();
  });

  it('correctly detects valid magic bytes for PDF, JPEG, PNG and rejects invalid files', () => {
    const pdfBuf = Buffer.from('%PDF-1.4 header text');
    const jpgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const exeBuf = Buffer.from('MZ\x90\x00\x03\x00\x00\x00'); // Windows PE header
    const htmlBuf = Buffer.from('<html><body>Fake Document</body></html>');

    expect(detectMagicBytes(pdfBuf)).toBe('pdf');
    expect(detectMagicBytes(jpgBuf)).toBe('jpg');
    expect(detectMagicBytes(pngBuf)).toBe('png');
    expect(detectMagicBytes(exeBuf)).toBeNull();
    expect(detectMagicBytes(htmlBuf)).toBeNull();
  });

  it('parses standard Meta Graph API Cloud webhook payload structure', () => {
    const rawMetaWebhook = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '16505551111',
                  phone_number_id: '123456123',
                },
                contacts: [
                  {
                    profile: { name: 'John Doe' },
                    wa_id: '919876543210',
                  },
                ],
                messages: [
                  {
                    from: '919876543210',
                    id: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgUM0EB',
                    timestamp: '1690000000',
                    text: { body: 'Hello PRINTOS' },
                    type: 'text',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const events = WhatsAppInboxService.parseMetaWebhookPayload(rawMetaWebhook);
    expect(events.length).toBe(1);
    expect(events[0].wamid).toBe('wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgUM0EB');
    expect(events[0].from).toBe('919876543210');
    expect(events[0].text).toBe('Hello PRINTOS');
    expect(events[0].type).toBe('text');
  });

  it('enforces durable wamid deduplication in inbox queue', async () => {
    const payload = {
      wamid: 'wamid_unique_123',
      from: '919876543210',
      type: 'text',
      text: 'First arrival',
    };

    // First ingestion -> should be accepted
    const first = await WhatsAppInboxService.ingestWebhook(payload, repo);
    expect(first.isDuplicate).toBe(false);
    expect(first.item).toBeDefined();

    // Second ingestion with identical wamid -> should be detected as duplicate
    const second = await WhatsAppInboxService.ingestWebhook(payload, repo);
    expect(second.isDuplicate).toBe(true);

    // Only 1 item should be claimable
    const claimed = await repo.claimInboxBatch('worker_1', 10);
    expect(claimed.length).toBe(1);
  });

  it('rejects files exceeding 50MB during streaming ingestion', async () => {
    const downloader = new WhatsAppMediaDownloader();
    const largeMediaId = 'large_media_999';

    // Mock stream providing > 50MB
    const mockProviderOverLimit = {
      async sendText() { return { providerMessageId: '' }; },
      async sendInteractiveButtons() { return { providerMessageId: '' }; },
      async sendDocument() { return { providerMessageId: '' }; },
      async getMediaUrl() {
        return { url: 'https://mock/large', mimeType: 'application/pdf', fileSize: 55 * 1024 * 1024 };
      },
      async downloadMediaStream() {
        // Return a stream that indicates 55MB
        return { stream: Readable.from([Buffer.alloc(100)]), contentLength: 55 * 1024 * 1024 };
      },
    };

    await expect(
      downloader.ingestMedia(mockProviderOverLimit as any, largeMediaId, 'big.pdf', '919876543210')
    ).rejects.toThrow(/exceeds maximum limit of 50MB/);
  });
});
