import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getRepository } from '@/lib/repository';
import { WhatsAppInboxService } from '@/lib/whatsapp/inbox-service';
import { WhatsAppWorkerEngine } from '@/lib/whatsapp/worker-engine';
import { globalRateLimiter } from '@/lib/security/rate-limiter';
import { createLogger } from '@/lib/observability/logger';

export const dynamic = 'force-dynamic';

const logger = createLogger('WhatsAppWebhookRoute');

/**
 * GET Handler: Meta WhatsApp Webhook Verification Challenge
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');

    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'printos_whatsapp_verify_token';

    if (mode === 'subscribe' && token === verifyToken) {
      logger.info('Meta webhook verification challenge passed');
      return new NextResponse(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    logger.warn('Meta webhook verification challenge failed: invalid token');
    return NextResponse.json({ error: 'Forbidden: Invalid verification token' }, { status: 403 });
  } catch (err: unknown) {
    logger.error('WhatsApp GET webhook challenge error', err instanceof Error ? err : undefined);
    return NextResponse.json({ error: 'Failed to process webhook verification' }, { status: 500 });
  }
}

/**
 * POST Handler: Inbound WhatsApp Webhook Ingestion (OpenWA & Meta Cloud API)
 */
export async function POST(req: NextRequest) {
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anonymous';
  const rateLimit = globalRateLimiter.check(`wa_webhook_${clientIp}`, 120, 60);

  if (!rateLimit.allowed) {
    logger.warn('Rate limit exceeded on WhatsApp webhook', { clientIp });
    return NextResponse.json(
      { error: 'Too many requests. Please slow down.' },
      {
        status: 429,
        headers: { 'Retry-After': String(rateLimit.resetInSeconds) },
      }
    );
  }

  try {
    const rawBody = await req.text();
    const openwaSignatureHeader = req.headers.get('x-openwa-signature');
    const metaSignatureHeader = req.headers.get('x-hub-signature-256');

    const openwaSecret = process.env.OPENWA_WEBHOOK_SECRET;
    const metaSecret = process.env.WHATSAPP_APP_SECRET;
    const provider = (process.env.WHATSAPP_PROVIDER || '').toLowerCase();
    const isProduction = process.env.NODE_ENV === 'production';

    // 1. Verify OpenWA HMAC-SHA256 signature when signature or OpenWA provider is used
    if (provider === 'openwa' || openwaSignatureHeader) {
      if (openwaSignatureHeader) {
        if (!openwaSecret) {
          logger.warn('Received signed OpenWA webhook but OPENWA_WEBHOOK_SECRET is not configured on server', { clientIp });
          return NextResponse.json({ error: 'Server OpenWA webhook secret is not configured to verify signature' }, { status: 401 });
        }

        const sigValue = openwaSignatureHeader.startsWith('sha256=')
          ? openwaSignatureHeader.replace('sha256=', '').trim()
          : openwaSignatureHeader.trim();

        const expectedSig = crypto
          .createHmac('sha256', openwaSecret)
          .update(rawBody)
          .digest('hex');

        const receivedSigBuf = Buffer.from(sigValue, 'hex');
        const expectedSigBuf = Buffer.from(expectedSig, 'hex');

        if (
          receivedSigBuf.length !== expectedSigBuf.length ||
          !crypto.timingSafeEqual(receivedSigBuf, expectedSigBuf)
        ) {
          logger.warn('Invalid OpenWA HMAC signature', { clientIp });
          return NextResponse.json({ error: 'Invalid OpenWA HMAC signature' }, { status: 401 });
        }
      } else if (openwaSecret && process.env.OPENWA_STRICT_SIGNATURE === 'true') {
        logger.warn('Missing X-OpenWA-Signature header under strict signature mode', { clientIp });
        return NextResponse.json({ error: 'Missing X-OpenWA-Signature header' }, { status: 401 });
      } else {
        logger.warn('Processing unsigned OpenWA webhook (OpenWA signature header not present)', { clientIp });
      }
    }

    // 2. Verify Meta HMAC-SHA256 signature
    if (provider === 'meta' || metaSignatureHeader) {
      if (metaSignatureHeader) {
        if (!metaSecret) {
          logger.warn('Received signed Meta webhook but WHATSAPP_APP_SECRET is not configured', { clientIp });
          return NextResponse.json({ error: 'Server Meta webhook secret is not configured' }, { status: 401 });
        }
        if (!metaSignatureHeader.startsWith('sha256=')) {
          logger.warn('Missing or malformed Meta signature header prefix', { clientIp });
          return NextResponse.json({ error: 'Missing or malformed signature header' }, { status: 401 });
        }

        const receivedSig = metaSignatureHeader.replace('sha256=', '').trim();
        const expectedSig = crypto
          .createHmac('sha256', metaSecret)
          .update(rawBody)
          .digest('hex');

        const receivedSigBuf = Buffer.from(receivedSig, 'hex');
        const expectedSigBuf = Buffer.from(expectedSig, 'hex');

        if (
          receivedSigBuf.length !== expectedSigBuf.length ||
          !crypto.timingSafeEqual(receivedSigBuf, expectedSigBuf)
        ) {
          logger.warn('Invalid Meta HMAC signature', { clientIp });
          return NextResponse.json({ error: 'Invalid Meta HMAC signature' }, { status: 401 });
        }
      } else if (isProduction && provider === 'meta' && metaSecret) {
        logger.warn('Missing Meta X-Hub-Signature-256 header in production', { clientIp });
        return NextResponse.json({ error: 'Missing X-Hub-Signature-256 header' }, { status: 401 });
      }
    }

    // 3. Parse incoming webhook payload (safe JSON parse)
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch (parseErr) {
      logger.warn('Malformed JSON payload received in WhatsApp webhook', { clientIp, error: parseErr });
      return NextResponse.json({ error: 'Malformed JSON payload' }, { status: 400 });
    }

    let parsedEvents: ReturnType<typeof WhatsAppInboxService.parseInboundPayload> = [];
    try {
      parsedEvents = WhatsAppInboxService.parseInboundPayload(body);
    } catch (parseErr) {
      logger.error('Failed to parse WhatsApp inbound payload', parseErr instanceof Error ? parseErr : undefined);
      return NextResponse.json({ error: 'Failed to parse webhook payload' }, { status: 400 });
    }

    if (parsedEvents.length === 0) {
      return NextResponse.json({ success: true, message: 'No actionable message events' }, { status: 200 });
    }

    const repo = getRepository();
    const enqueuedCount = await WhatsAppInboxService.enqueueInboundEvents(parsedEvents, repo);

    logger.info('Ingested inbound WhatsApp events', {
      eventCount: parsedEvents.length,
      enqueuedCount,
      sender: parsedEvents[0]?.from,
    });

    // Eager best-effort asynchronous cycle trigger (Latency optimization only; Cron is authoritative)
    if (process.env.DISABLE_EAGER_WORKER !== 'true') {
      try {
        const worker = new WhatsAppWorkerEngine(repo);
        worker.runCycle().catch((e) => {
          logger.warn('Background worker cycle failed, deferring to cron', { error: e });
        });
      } catch (workerErr) {
        logger.warn('Failed to start eager worker cycle, deferring to cron', { error: workerErr });
      }
    }

    return NextResponse.json({
      success: true,
      enqueued: enqueuedCount,
      eventsReceived: parsedEvents.length,
    });
  } catch (err: unknown) {
    logger.error('WhatsApp Webhook Ingestion Error', err instanceof Error ? err : undefined);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal webhook error' },
      { status: 500 }
    );
  }
}
