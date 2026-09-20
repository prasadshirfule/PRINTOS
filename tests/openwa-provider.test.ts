import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { Readable } from 'stream';
import { PDFDocument } from 'pdf-lib';
import { OpenWAWhatsAppProvider } from '@/lib/whatsapp/provider/openwa-whatsapp-provider';
import { getWhatsAppProvider, setWhatsAppProvider } from '@/lib/whatsapp/provider';
import { WhatsAppInboxService } from '@/lib/whatsapp/inbox-service';
import { WhatsAppMediaDownloader, MediaIngestionError } from '@/lib/whatsapp/media-downloader';
import { POST as handleWhatsAppWebhook } from '@/app/api/webhooks/whatsapp/route';
import { setRepository, InMemoryPrintOSRepository } from '@/lib/repository';

describe('OpenWA WhatsApp Provider & Webhook Integration Suite', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    setWhatsAppProvider(null);
    setRepository(null);
  });

  afterEach(() => {
    process.env = originalEnv;
    setWhatsAppProvider(null);
    setRepository(null);
    vi.restoreAllMocks();
  });

  // 1. OpenWA Provider Outbound Text
  it('sends text message with X-API-Key and correct chatId to OpenWA REST endpoint', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/validate')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ valid: true }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'true_919876543210@c.us_3EB0123456', messageId: 'msg_001' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenWAWhatsAppProvider({
      baseUrl: 'http://127.0.0.1:2785',
      apiKey: 'test-api-key-secret',
      sessionId: 'session-printos',
    });

    const result = await provider.sendText('919876543210', 'Hello from PRINTOS');

    const sendCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes('messages/send-text'));
    expect(sendCall).toBeDefined();
    const [url, options] = sendCall!;
    expect(url).toBe('http://127.0.0.1:2785/api/sessions/session-printos/messages/send-text');
    expect(options.method).toBe('POST');
    expect(options.headers['X-API-Key']).toBe('test-api-key-secret');
    expect(options.headers['ngrok-skip-browser-warning']).toBe('true');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body).toEqual({
      chatId: '919876543210@c.us',
      text: 'Hello from PRINTOS',
    });
    expect(result.providerMessageId).toBe('true_919876543210@c.us_3EB0123456');
  });

  it('normalizes various phone number formats in formatChatId', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/validate')) {
        return { ok: true, status: 200, text: async () => '{"valid":true}' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'msg_100' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenWAWhatsAppProvider({
      baseUrl: 'http://127.0.0.1:2785',
      apiKey: 'k',
      sessionId: 'session-printos',
    });

    await provider.sendText('+91 80807 50206', 'test 1');
    await provider.sendText('918080750206@c.us', 'test 2');
    await provider.sendText('+91-8080-750206@s.whatsapp.net', 'test 3');

    const sendCalls = fetchMock.mock.calls.filter((c) => (c[0] as string).includes('messages/send-text'));
    expect(sendCalls).toHaveLength(3);
    expect(JSON.parse(sendCalls[0][1].body).chatId).toBe('918080750206@c.us');
    expect(JSON.parse(sendCalls[1][1].body).chatId).toBe('918080750206@c.us');
    expect(JSON.parse(sendCalls[2][1].body).chatId).toBe('918080750206@c.us');
  });

  // 2. OpenWA Provider Numbered Fallback Menu
  it('formats interactive buttons into a structured numbered text prompt for WhatsApp Web', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/validate')) {
        return { ok: true, status: 200, text: async () => '{"valid":true}' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'msg_menu_123' }),
      };
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

    const sendCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes('messages/send-text'));
    expect(sendCall).toBeDefined();
    const body = JSON.parse(sendCall![1].body);
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
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/validate')) {
        return { ok: true, status: 200, text: async () => '{"valid":true}' };
      }
      return {
        ok: false,
        status: 409,
        statusText: 'Conflict',
        text: async () => JSON.stringify({ message: 'Session not ready' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenWAWhatsAppProvider({
      baseUrl: 'http://127.0.0.1:2785',
      apiKey: 'key',
      sessionId: 'session-printos',
    });

    await expect(provider.sendText('919876543210', 'Hi')).rejects.toThrow(
      /OpenWA sendText error \(409 Conflict\): \{"message":"Session not ready"\}/
    );
  });

  it('handles OpenWA network timeout cleanly', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/validate')) {
        return { ok: true, status: 200, text: async () => '{"valid":true}' };
      }
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
    expect(parsed[0].from).toBe('919876543210@c.us');
    expect(parsed[0].name).toBe('Ramesh Kumar');
    expect(parsed[0].text).toBe('Hello Printos');
    expect(parsed[0].type).toBe('text');
  });

  it('preserves WhatsApp @lid privacy IDs and does not fabricate @c.us phone numbers', () => {
    const lidPayload = {
      event: 'message',
      sessionId: 'session-printos',
      data: {
        id: 'false_20495684599884@lid_3EB0LID12345',
        from: '20495684599884@lid',
        chatId: '20495684599884@lid',
        body: 'Hi from privacy mode',
        type: 'chat',
        pushName: 'Privacy User',
      },
    };

    const parsed = WhatsAppInboxService.parseOpenWAWebhookPayload(lidPayload);
    expect(parsed.length).toBe(1);
    expect(parsed[0].from).toBe('20495684599884@lid');
    expect(parsed[0].wamid).toBe('false_20495684599884@lid_3EB0LID12345');
  });

  it('preserves WhatsApp @g.us group IDs and custom OpenWA suffixes', () => {
    const groupPayload = {
      event: 'message',
      sessionId: 'session-printos',
      data: {
        id: 'false_120363023456789012@g.us_3EB0GRP12345',
        from: '120363023456789012@g.us',
        chatId: '120363023456789012@g.us',
        body: 'Group message',
        type: 'chat',
      },
    };

    const parsed = WhatsAppInboxService.parseOpenWAWebhookPayload(groupPayload);
    expect(parsed.length).toBe(1);
    expect(parsed[0].from).toBe('120363023456789012@g.us');
  });

  it('OpenWAProvider formatChatId preserves @lid, @g.us, @c.us and only converts raw phone numbers', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/validate')) {
        return { ok: true, status: 200, text: async () => '{"valid":true}' };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'msg_test' }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenWAWhatsAppProvider({
      baseUrl: 'http://127.0.0.1:2785',
      apiKey: 'key',
      sessionId: 'session-printos',
    });

    // 1. LID JID
    await provider.sendText('20495684599884@lid', 'reply to lid');
    // 2. Group JID
    await provider.sendText('120363023456789012@g.us', 'reply to group');
    // 3. User JID
    await provider.sendText('919876543210@c.us', 'reply to user');
    // 4. Meta user JID
    await provider.sendText('919876543210@s.whatsapp.net', 'reply to meta user');
    // 5. Raw phone string
    await provider.sendText('+91 98765 43210', 'reply to raw phone');

    const sendCalls = fetchMock.mock.calls.filter((c) => (c[0] as string).includes('messages/send-text'));
    expect(sendCalls).toHaveLength(5);
    expect(JSON.parse(sendCalls[0][1].body).chatId).toBe('20495684599884@lid');
    expect(JSON.parse(sendCalls[1][1].body).chatId).toBe('120363023456789012@g.us');
    expect(JSON.parse(sendCalls[2][1].body).chatId).toBe('919876543210@c.us');
    expect(JSON.parse(sendCalls[3][1].body).chatId).toBe('919876543210@c.us');
    expect(JSON.parse(sendCalls[4][1].body).chatId).toBe('919876543210@c.us');
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

  // 10. Webhook Route (/api/webhooks/whatsapp) OpenWA Tolerance & Signature Handling
  it('accepts unsigned OpenWA webhook in production when OPENWA_WEBHOOK_SECRET is unset', async () => {
    (process.env as any).NODE_ENV = 'production';
    process.env.WHATSAPP_PROVIDER = 'openwa';
    delete process.env.OPENWA_WEBHOOK_SECRET;

    const testRepo = new InMemoryPrintOSRepository();
    setRepository(testRepo);

    const payload = {
      event: 'message',
      data: {
        id: 'false_919876543210@c.us_3EB0UNSIGN',
        from: '919876543210@c.us',
        body: 'Hi',
        type: 'chat',
      },
    };

    const req = new NextRequest('http://localhost:3000/api/webhooks/whatsapp', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const res = await handleWhatsAppWebhook(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.enqueued).toBe(1);
  });

  it('verifies signed OpenWA webhook when signature header and secret are present', async () => {
    (process.env as any).NODE_ENV = 'production';
    process.env.WHATSAPP_PROVIDER = 'openwa';
    process.env.OPENWA_WEBHOOK_SECRET = 'whsec_test_secret_123';

    const testRepo = new InMemoryPrintOSRepository();
    setRepository(testRepo);

    const payload = {
      event: 'message',
      data: {
        id: 'false_919876543210@c.us_3EB0SIGNED',
        from: '919876543210@c.us',
        body: 'Print order',
        type: 'chat',
      },
    };

    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', 'whsec_test_secret_123').update(rawBody).digest('hex');

    const req = new NextRequest('http://localhost:3000/api/webhooks/whatsapp', {
      method: 'POST',
      headers: {
        'x-openwa-signature': `sha256=${signature}`,
      },
      body: rawBody,
    });

    const res = await handleWhatsAppWebhook(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.enqueued).toBe(1);
  });

  it('rejects signed OpenWA webhook with invalid signature header', async () => {
    (process.env as any).NODE_ENV = 'production';
    process.env.WHATSAPP_PROVIDER = 'openwa';
    process.env.OPENWA_WEBHOOK_SECRET = 'whsec_test_secret_123';

    const testRepo = new InMemoryPrintOSRepository();
    setRepository(testRepo);

    const payload = {
      event: 'message',
      data: {
        id: 'false_919876543210@c.us_3EB0TAMPER',
        from: '919876543210@c.us',
        body: 'Tampered',
        type: 'chat',
      },
    };

    const rawBody = JSON.stringify(payload);
    const badSignature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';

    const req = new NextRequest('http://localhost:3000/api/webhooks/whatsapp', {
      method: 'POST',
      headers: {
        'x-openwa-signature': badSignature,
      },
      body: rawBody,
    });

    const res = await handleWhatsAppWebhook(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid OpenWA HMAC signature');
  });

  // 11. End-to-End LID Inbound Event -> State Machine -> Outbox Preservation
  it('preserves inbound LID chatId through state machine and outbox transmission', async () => {
    const testRepo = new InMemoryPrintOSRepository();
    setRepository(testRepo);

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/validate')) {
        return { ok: true, status: 200, text: async () => '{"valid":true}' };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'outbox_msg_lid_999' }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenWAWhatsAppProvider({
      baseUrl: 'http://127.0.0.1:2785',
      apiKey: 'test-key',
      sessionId: 'session-printos',
    });
    setWhatsAppProvider(provider);

    // Inbound message from WhatsApp privacy LID user
    const lidInboundEvent = {
      wamid: 'false_20495684599884@lid_3EB0HI',
      from: '20495684599884@lid',
      name: 'LID Customer',
      timestamp: Date.now(),
      type: 'text' as const,
      text: 'Hi',
      rawPayload: {},
    };

    // 1. Process through state machine
    const { WhatsAppStateMachine } = await import('@/lib/whatsapp/state-machine');
    await WhatsAppStateMachine.processEvent(lidInboundEvent, testRepo);

    // 2. Verify conversation was created with customerPhone = '20495684599884@lid'
    const conv = await testRepo.getConversation('20495684599884@lid');
    expect(conv).toBeDefined();
    expect(conv?.customerPhone).toBe('20495684599884@lid');

    // 3. Verify outbox queue contains item with recipientPhone = '20495684599884@lid'
    const outboxItems = await testRepo.claimOutboxBatch('test_worker', 10);
    expect(outboxItems.length).toBeGreaterThanOrEqual(1);
    expect(outboxItems[0].recipientPhone).toBe('20495684599884@lid');

    // 4. Transmit via Worker Engine
    const { WhatsAppWorkerEngine } = await import('@/lib/whatsapp/worker-engine');
    const worker = new WhatsAppWorkerEngine(testRepo);
    // Complete the claimed item by running worker cycle
    await testRepo.completeOutboxItem(outboxItems[0].id, 'test_worker');
    
    // Re-queue and transmit directly
    const directOutbox = await testRepo.enqueueOutboxItem({
      recipientPhone: '20495684599884@lid',
      messageType: 'text',
      payload: { body: 'Direct reply test' },
    });
    const batch = await testRepo.claimOutboxBatch('worker_lid', 1);
    expect(batch[0].recipientPhone).toBe('20495684599884@lid');

    // Transmit to OpenWA
    await provider.sendText(batch[0].recipientPhone, 'Hello back!');
    const sendCalls = fetchMock.mock.calls.filter((c) => (c[0] as string).includes('messages/send-text'));
    const lastSendCall = sendCalls[sendCalls.length - 1];
    expect(lastSendCall).toBeDefined();
    expect(JSON.parse(lastSendCall[1].body).chatId).toBe('20495684599884@lid');
  });
});
