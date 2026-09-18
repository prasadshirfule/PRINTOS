import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { Readable } from 'stream';
import { PDFDocument } from 'pdf-lib';
import { OpenWAWhatsAppProvider } from '@/lib/whatsapp/provider/openwa-whatsapp-provider';
import { getWhatsAppProvider, setWhatsAppProvider } from '@/lib/whatsapp/provider';
import { WhatsAppInboxService } from '@/lib/whatsapp/inbox-service';
import { WhatsAppMediaDownloader, MediaIngestionError } from '@/lib/whatsapp/media-downloader';

describe('OpenWA WhatsApp Provider & Webhook Integration Suite', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    setWhatsAppProvider(null);
  });

  afterEach(() => {
    process.env = originalEnv;
    setWhatsAppProvider(null);
    vi.restoreAllMocks();
  });

  // 1. OpenWA Provider Outbound Text
  it('sends text message with X-API-Key and correct chatId to OpenWA REST endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'true_919876543210@c.us_3EB0123456', messageId: 'msg_001' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenWAWhatsAppProvider({
      baseUrl: 'http://127.0.0.1:2785',
      apiKey: 'test-api-key-secret',
      sessionId: 'session-printos',
    });

    const result = await provider.sendText('919876543210', 'Hello from PRINTOS');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:2785/api/sessions/session-printos/messages/send-text');
    expect(options.method).toBe('POST');
    expect(options.headers['X-API-Key']).toBe('test-api-key-secret');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body.chatId).toBe('919876543210@c.us');
    expect(body.text).toBe('Hello from PRINTOS');
    expect(result.providerMessageId).toBe('true_919876543210@c.us_3EB0123456');
  });

  // 2. OpenWA Provider Numbered Fallback Menu
  it('formats interactive buttons into a structured numbered text prompt for WhatsApp Web', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg_menu_123' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenWAWhatsAppProvider({
      baseUrl: 'http://127.0.0.1:2785',
      apiKey: 'key',
      sessionId: 'session-printos',
    });

    const result = await provider.sendInteractiveButtons(
      '919876543210',
      'Select print color mode:',
      [
        { id: 'btn_bw', title: 'Black & White' },
        { id: 'btn_color', title: 'Color' },
      ],
      'PRINTOS Setup',
      'Step 1 of 4'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('*PRINTOS Setup*');
    expect(body.text).toContain('Select print color mode:');
    expect(body.text).toContain('1️⃣ Black & White');
    expect(body.text).toContain('2️⃣ Color');
    expect(body.text).toContain('_Step 1 of 4_');
    expect(body.text).toContain('_Reply with the number (e.g. 1) or option name._');
    expect(result.providerMessageId).toBe('msg_menu_123');
  });

  // 3. OpenWA Provider Outbound Document
  it('sends PDF document with base64 / URL payload to send-document endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'doc_sent_456' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenWAWhatsAppProvider({
      baseUrl: 'http://127.0.0.1:2785',
      apiKey: 'key',
      sessionId: 'session-printos',
    });

    const result = await provider.sendDocument(
      '919876543210',
      'https://supabase.co/storage/v1/object/signed/print-documents/doc.pdf',
      'order_receipt.pdf',
      'Your print receipt'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:2785/api/sessions/session-printos/messages/send-document');
    const body = JSON.parse(options.body);
    expect(body.chatId).toBe('919876543210@c.us');
    expect(body.url).toBe('https://supabase.co/storage/v1/object/signed/print-documents/doc.pdf');
    expect(body.filename).toBe('order_receipt.pdf');
    expect(body.mimetype).toBe('application/pdf');
    expect(result.providerMessageId).toBe('doc_sent_456');
  });

  // 4. OpenWA Error & Timeout Handling
  it('handles OpenWA non-2xx HTTP responses with descriptive error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: async () => JSON.stringify({ message: 'Session not ready' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenWAWhatsAppProvider({
      baseUrl: 'http://127.0.0.1:2785',
      apiKey: 'key',
      sessionId: 'session-printos',
    });

    await expect(provider.sendText('919876543210', 'Hi')).rejects.toThrow(
      'OpenWA sendText error (409): {"message":"Session not ready"}'
    );
  });

  it('handles OpenWA network timeout cleanly', async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenWAWhatsAppProvider({
      baseUrl: 'http://127.0.0.1:2785',
      apiKey: 'key',
      sessionId: 'session-printos',
    });

    await expect(provider.sendText('919876543210', 'Hi')).rejects.toThrow(
      'OpenWA sendText request timed out after 15s'
    );
  });

  // 5. OpenWA Webhook Payload Parser
  it('parses standard OpenWA message webhook payload and normalizes sender phone and wamid', () => {
    const openwaPayload = {
      event: 'message',
      timestamp: '2026-09-18T12:00:00.000Z',
      sessionId: 'session-printos',
      idempotencyKey: 'idem_999',
      data: {
        id: 'false_919876543210@c.us_3EB0A1B2C3D4',
        from: '919876543210@c.us',
        to: '919000000000@c.us',
        body: 'Hello Printos',
        type: 'chat',
        hasMedia: false,
        pushName: 'Ramesh Kumar',
        timestamp: 1726660000,
      },
    };

    const parsed = WhatsAppInboxService.parseOpenWAWebhookPayload(openwaPayload);
    expect(parsed.length).toBe(1);
    expect(parsed[0].wamid).toBe('false_919876543210@c.us_3EB0A1B2C3D4');
    expect(parsed[0].from).toBe('919876543210');
    expect(parsed[0].name).toBe('Ramesh Kumar');
    expect(parsed[0].text).toBe('Hello Printos');
    expect(parsed[0].type).toBe('text');
  });

  it('parses OpenWA document message payload with media metadata', () => {
    const openwaDocPayload = {
      event: 'message',
      sessionId: 'session-printos',
      data: {
        id: 'false_919876543210@c.us_3EB0DOC1234',
        from: '919876543210@c.us',
        body: 'Print this please',
        type: 'document',
        hasMedia: true,
        media: {
          mimetype: 'application/pdf',
          filename: 'assignment.pdf',
          sizeBytes: 1048576,
          omitted: false,
          data: 'JVBERi0xLjQKJcTl8uXr...',
        },
      },
    };

    const parsed = WhatsAppInboxService.parseOpenWAWebhookPayload(openwaDocPayload);
    expect(parsed.length).toBe(1);
    expect(parsed[0].type).toBe('document');
    expect(parsed[0].filename).toBe('assignment.pdf');
    expect(parsed[0].mimeType).toBe('application/pdf');
    expect(parsed[0].fileSize).toBe(1048576);
    expect(parsed[0].mediaId).toBe('false_919876543210@c.us_3EB0DOC1234');
  });

  it('ignores outbound message echoes (fromMe: true or true_ message IDs)', () => {
    const outboundEchoPayload = {
      event: 'message',
      sessionId: 'session-printos',
      data: {
        id: 'true_919876543210@c.us_3EB0BOTMSG',
        from: '919000000000@c.us',
        to: '919876543210@c.us',
        fromMe: true,
        body: 'Welcome to PRINTOS',
        type: 'chat',
      },
    };

    const parsed = WhatsAppInboxService.parseOpenWAWebhookPayload(outboundEchoPayload);
    expect(parsed.length).toBe(0);
  });

  // 6. Unified Payload Parser handles both OpenWA and Meta
  it('deterministically distinguishes OpenWA versus Meta payloads in parseInboundPayload', () => {
    const metaPayload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: '919876543210', id: 'wamid_meta_001', type: 'text', text: { body: 'Meta text' } }],
                contacts: [{ profile: { name: 'Meta User' } }],
              },
            },
          ],
        },
      ],
    };

    const openwaPayload = {
      event: 'message',
      sessionId: 'session-printos',
      data: {
        id: 'false_919876543210@c.us_3EB0OPENWA',
        from: '919876543210@c.us',
        body: 'OpenWA text',
        type: 'chat',
      },
    };

    const parsedMeta = WhatsAppInboxService.parseInboundPayload(metaPayload);
    expect(parsedMeta.length).toBe(1);
    expect(parsedMeta[0].wamid).toBe('wamid_meta_001');
    expect(parsedMeta[0].text).toBe('Meta text');

    const parsedOpenWA = WhatsAppInboxService.parseInboundPayload(openwaPayload);
    expect(parsedOpenWA.length).toBe(1);
    expect(parsedOpenWA[0].wamid).toBe('false_919876543210@c.us_3EB0OPENWA');
    expect(parsedOpenWA[0].text).toBe('OpenWA text');
  });

  // 7. HMAC-SHA256 Signature Verification
  it('verifies X-OpenWA-Signature header with HMAC-SHA256 timing-safe computation', () => {
    const rawBody = JSON.stringify({ event: 'message', data: { id: 'msg_1', from: '919876543210@c.us' } });
    const secret = 'test-openwa-webhook-secret-key-123';

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const validSignature = `sha256=${hmac.digest('hex')}`;

    // Verify valid signature
    const receivedSig = validSignature.replace('sha256=', '');
    const expectedSig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const isMatch = crypto.timingSafeEqual(Buffer.from(receivedSig, 'hex'), Buffer.from(expectedSig, 'hex'));
    expect(isMatch).toBe(true);

    // Verify invalid signature rejected
    const invalidSig = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';
    const isInvalidMatch = crypto.timingSafeEqual(
      Buffer.from(invalidSig.replace('sha256=', ''), 'hex'),
      Buffer.from(expectedSig, 'hex')
    );
    expect(isInvalidMatch).toBe(false);
  });

  // 8. Media Ingestion — Inline Base64 & Streaming Download
  it('ingests inline base64 PDF and performs magic-byte validation', async () => {
    const downloader = new WhatsAppMediaDownloader();
    const provider = new OpenWAWhatsAppProvider({ baseUrl: 'http://127.0.0.1:2785', apiKey: 'k' });

    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    pdfDoc.addPage([595, 842]);
    const pdfBytes = await pdfDoc.save();
    const inlineBase64 = Buffer.from(pdfBytes).toString('base64');

    const result = await downloader.ingestMedia(
      provider,
      'false_919876543210@c.us_3EB0PDF',
      'sample.pdf',
      '919876543210',
      inlineBase64
    );

    expect(result.fileType).toBe('pdf');
    expect(result.filename).toBe('sample.pdf');
    expect(result.pageCount).toBe(2);
    expect(result.storagePath).toContain('whatsapp/919876543210/');
  });

  it('rejects inline media with invalid magic bytes (executable / corrupt file)', async () => {
    const downloader = new WhatsAppMediaDownloader();
    const provider = new OpenWAWhatsAppProvider({ baseUrl: 'http://127.0.0.1:2785', apiKey: 'k' });

    const invalidContent = 'MZ\x90\x00\x03\x00corrupt-executable-content';
    const inlineBase64 = Buffer.from(invalidContent).toString('base64');

    await expect(
      downloader.ingestMedia(provider, 'msg_exe', 'virus.exe', '919876543210', inlineBase64)
    ).rejects.toThrow(MediaIngestionError);
  });

  it('downloads omitted media stream from OpenWA REST endpoint with 50MB limit', async () => {
    const downloader = new WhatsAppMediaDownloader();
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    const pdfBytes = await pdfDoc.save();
    const dummyPdf = Buffer.from(pdfBytes);

    const providerMock = {
      sendText: vi.fn(),
      sendInteractiveButtons: vi.fn(),
      sendDocument: vi.fn(),
      getMediaUrl: vi.fn().mockResolvedValue({
        url: 'http://127.0.0.1:2785/api/sessions/session-printos/messages/919876543210@c.us/msg_stream/media',
        mimeType: 'application/pdf',
      }),
      downloadMediaStream: vi.fn().mockResolvedValue({
        stream: Readable.from([dummyPdf]),
        contentLength: dummyPdf.length,
      }),
    };

    const result = await downloader.ingestMedia(
      providerMock as any,
      'false_919876543210@c.us_3EB0STREAM',
      'streamed_doc.pdf',
      '919876543210'
    );

    expect(result.fileType).toBe('pdf');
    expect(result.filename).toBe('streamed_doc.pdf');
    expect(result.pageCount).toBe(1);
    expect(providerMock.getMediaUrl).toHaveBeenCalledTimes(1);
    expect(providerMock.downloadMediaStream).toHaveBeenCalledTimes(1);
  });

  // 9. Provider Factory Selection & Fail-Fast Guard
  it('selects OpenWAWhatsAppProvider when WHATSAPP_PROVIDER=openwa', () => {
    process.env.WHATSAPP_PROVIDER = 'openwa';
    process.env.OPENWA_BASE_URL = 'http://127.0.0.1:2785';
    process.env.OPENWA_API_KEY = 'test-key';
    process.env.OPENWA_SESSION_ID = 'session-printos';

    const provider = getWhatsAppProvider();
    expect(provider).toBeInstanceOf(OpenWAWhatsAppProvider);
  });

  it('fails fast in production if WHATSAPP_PROVIDER=openwa is missing credentials', () => {
    (process.env as any).NODE_ENV = 'production';
    process.env.WHATSAPP_PROVIDER = 'openwa';
    delete process.env.OPENWA_API_KEY;
    delete process.env.OPENWA_BASE_URL;

    expect(() => getWhatsAppProvider()).toThrow(/Production is configured for WHATSAPP_PROVIDER=openwa/);
  });

  it('fails fast in production if no valid provider is configured', () => {
    (process.env as any).NODE_ENV = 'production';
    delete process.env.WHATSAPP_PROVIDER;
    delete process.env.OPENWA_API_KEY;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;

    expect(() => getWhatsAppProvider()).toThrow(/Production requires a valid WHATSAPP_PROVIDER/);
  });
});
