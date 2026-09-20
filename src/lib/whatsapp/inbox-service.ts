import { InboundWhatsAppEvent, WhatsAppInboxItem } from '@/types/whatsapp';
import { IPrintOSRepository } from '@/lib/repository';

export class WhatsAppInboxService {
  /**
   * Normalize an inbound WhatsApp chat ID or sender while preserving explicit JID domains
   * (@c.us, @lid, @g.us, etc.).
   */
  public static normalizeInboundChatId(rawId: string): string {
    const trimmed = (rawId || '').trim();
    if (!trimmed) {
      return '';
    }

    // 1. If explicit WhatsApp JID domain is present
    if (trimmed.includes('@')) {
      const atIndex = trimmed.lastIndexOf('@');
      const userPart = trimmed.slice(0, atIndex).replace(/^\+/, '');
      const domainPart = trimmed.slice(atIndex + 1).toLowerCase();

      // Normalize Meta Graph API / standard WA user domain to standard OpenWA user JID
      if (domainPart === 's.whatsapp.net') {
        const cleanedUser = userPart.replace(/\D/g, '');
        return `${cleanedUser}@c.us`;
      }

      // Preserve @lid (Privacy / Linked Device ID), @g.us (Group), @c.us (User), etc.
      return `${userPart}@${domainPart}`;
    }

    // 2. Pure digits or phone string without domain (e.g. from Meta Graph API)
    return trimmed.replace(/\D/g, '');
  }

  /**
   * Parse a raw WhatsApp webhook payload (OpenWA, Meta Graph API, or Direct Test Simulation)
   * into a normalized InboundWhatsAppEvent.
   */
  public static parseWebhookPayload(rawPayload: Record<string, unknown>): InboundWhatsAppEvent | null {
    if (!rawPayload || typeof rawPayload !== 'object') {
      return null;
    }

    // 1. Direct simulation payload format (used in unit/acceptance tests)
    if (typeof rawPayload.wamid === 'string' && typeof rawPayload.from === 'string') {
      return {
        wamid: rawPayload.wamid,
        from: this.normalizeInboundChatId(String(rawPayload.from)),
        name: typeof rawPayload.name === 'string' ? rawPayload.name : undefined,
        timestamp: typeof rawPayload.timestamp === 'number' ? rawPayload.timestamp : Date.now(),
        type: (rawPayload.type as InboundWhatsAppEvent['type']) || 'text',
        text: typeof rawPayload.text === 'string' ? rawPayload.text : undefined,
        buttonId: typeof rawPayload.buttonId === 'string' ? rawPayload.buttonId : undefined,
        mediaId: typeof rawPayload.mediaId === 'string' ? rawPayload.mediaId : undefined,
        mimeType: typeof rawPayload.mimeType === 'string' ? rawPayload.mimeType : undefined,
        filename: typeof rawPayload.filename === 'string' ? rawPayload.filename : undefined,
        fileSize: typeof rawPayload.fileSize === 'number' ? rawPayload.fileSize : undefined,
        rawPayload,
      };
    }

    // 2. OpenWA Webhook Envelope Format (e.g. event: 'message' / 'message.received', or data + sessionId)
    if (
      typeof rawPayload.event === 'string' ||
      (rawPayload.data && (rawPayload.sessionId || (rawPayload.data as any)?.id))
    ) {
      const openwaEvents = this.parseOpenWAWebhookPayload(rawPayload);
      return openwaEvents[0] || null;
    }

    // 3. Official Meta Graph API Cloud Webhook structure
    const entry = (rawPayload.entry as any[])?.[0];
    const change = (entry?.changes as any[])?.[0];
    const value = change?.value;
    const message = (value?.messages as any[])?.[0];
    const contact = (value?.contacts as any[])?.[0];

    if (!message || !message.id || !message.from) {
      return null;
    }

    const from = String(message.from).replace(/\D/g, '');
    const wamid = String(message.id);
    const name = contact?.profile?.name || undefined;
    const timestamp = message.timestamp ? Number(message.timestamp) * 1000 : Date.now();
    const type = message.type || 'unknown';

    let text: string | undefined;
    let buttonId: string | undefined;
    let mediaId: string | undefined;
    let mimeType: string | undefined;
    let filename: string | undefined;
    let fileSize: number | undefined;

    if (type === 'text') {
      text = message.text?.body;
    } else if (type === 'interactive') {
      const interactive = message.interactive;
      if (interactive.type === 'button_reply') {
        buttonId = interactive.button_reply?.id;
        text = interactive.button_reply?.title;
      } else if (interactive.type === 'list_reply') {
        buttonId = interactive.list_reply?.id;
        text = interactive.list_reply?.title;
      }
    } else if (type === 'button') {
      buttonId = message.button?.payload || message.button?.text;
      text = message.button?.text;
    } else if (type === 'document') {
      mediaId = message.document?.id;
      mimeType = message.document?.mime_type;
      filename = message.document?.filename;
      fileSize = message.document?.file_size;
      text = message.document?.caption;
    } else if (type === 'image') {
      mediaId = message.image?.id;
      mimeType = message.image?.mime_type;
      fileSize = message.image?.file_size;
      text = message.image?.caption;
    }

    return {
      wamid,
      from,
      name,
      timestamp,
      type: type as InboundWhatsAppEvent['type'],
      text: text?.trim(),
      buttonId,
      mediaId,
      mimeType,
      filename,
      fileSize,
      rawPayload,
    };
  }

  /**
   * Parse inbound events from an OpenWA Webhook body
   */
  public static parseOpenWAWebhookPayload(body: Record<string, unknown>): InboundWhatsAppEvent[] {
    const events: InboundWhatsAppEvent[] = [];
    if (!body || typeof body !== 'object') {
      return events;
    }

    const eventName = typeof body.event === 'string' ? body.event : '';
    // Skip events that are not message receipts (e.g. status, session.qr) unless payload contains message data
    const data = (body.data as Record<string, unknown>) || body;

    if (!data || typeof data !== 'object' || !data.id || (!data.from && !data.chatId && !(data.sender as any)?.id)) {
      return events;
    }

    // Skip echo messages sent by our own bot account
    if (data.fromMe === true || (typeof data.id === 'string' && data.id.startsWith('true_'))) {
      return events;
    }

    // In OpenWA, chatId / from preserves the original recipient target (@c.us, @lid, @g.us)
    const rawTarget = String(data.chatId || data.from || (data.sender as any)?.id || '');
    const from = this.normalizeInboundChatId(rawTarget);
    if (!from) {
      return events;
    }

    const wamid = String(data.id);
    const name =
      (typeof data.pushName === 'string' ? data.pushName : undefined) ||
      (typeof data.notifyName === 'string' ? data.notifyName : undefined) ||
      (typeof (data._data as any)?.notifyName === 'string' ? (data._data as any).notifyName : undefined);

    const timestamp = typeof data.timestamp === 'number' ? data.timestamp * 1000 : Date.now();
    const rawType = String(data.type || 'chat').toLowerCase();

    let type: InboundWhatsAppEvent['type'] = 'text';
    if (rawType === 'document') {
      type = 'document';
    } else if (rawType === 'image') {
      type = 'image';
    } else if (rawType === 'chat' || rawType === 'text') {
      type = 'text';
    } else {
      type = 'unknown';
    }

    let text: string | undefined = typeof data.body === 'string' ? data.body.trim() : undefined;

    // Handle interactive poll vote or button click in OpenWA if provided
    let buttonId: string | undefined;
    if (data.selectedButtonId && typeof data.selectedButtonId === 'string') {
      buttonId = data.selectedButtonId;
    } else if (data.selectedRowId && typeof data.selectedRowId === 'string') {
      buttonId = data.selectedRowId;
    }

    // Media metadata extraction
    const media = (data.media as Record<string, unknown>) || undefined;
    const hasMedia = Boolean(data.hasMedia || media || type === 'document' || type === 'image');

    let mimeType: string | undefined =
      typeof media?.mimetype === 'string'
        ? media.mimetype
        : typeof data.mimetype === 'string'
        ? data.mimetype
        : undefined;

    let filename: string | undefined =
      typeof media?.filename === 'string'
        ? media.filename
        : typeof data.filename === 'string'
        ? data.filename
        : undefined;

    let fileSize: number | undefined =
      typeof media?.sizeBytes === 'number'
        ? media.sizeBytes
        : typeof data.fileSize === 'number'
        ? data.fileSize
        : undefined;

    // In OpenWA, the message ID is used to fetch media from the REST endpoint
    const mediaId = hasMedia ? wamid : undefined;

    events.push({
      wamid,
      from,
      name,
      timestamp,
      type,
      text,
      buttonId,
      mediaId,
      mimeType,
      filename,
      fileSize,
      rawPayload: body,
    });

    return events;
  }

  /**
   * Parse a batch of inbound events from any supported webhook payload (OpenWA or Meta)
   */
  public static parseInboundPayload(body: Record<string, unknown>): InboundWhatsAppEvent[] {
    if (!body || typeof body !== 'object') {
      return [];
    }

    // 1. Direct simulation check
    if (typeof body.wamid === 'string' && typeof body.from === 'string') {
      const single = this.parseWebhookPayload(body);
      return single ? [single] : [];
    }

    // 2. OpenWA format check
    if (
      typeof body.event === 'string' ||
      (body.sessionId && body.data) ||
      (body.data && (body.data as any)?.from && (body.data as any)?.id)
    ) {
      return this.parseOpenWAWebhookPayload(body);
    }

    // 3. Meta Graph API format check
    if (Array.isArray(body.entry)) {
      return this.parseMetaWebhookPayload(body);
    }

    // Fallback: try direct parse
    const fallback = this.parseWebhookPayload(body);
    return fallback ? [fallback] : [];
  }

  /**
   * Enqueue raw webhook event to durable inbox in database
   */
  public static async ingestWebhook(
    rawPayload: Record<string, unknown>,
    repo: IPrintOSRepository
  ): Promise<{ event: InboundWhatsAppEvent | null; item: WhatsAppInboxItem | null; isDuplicate: boolean }> {
    const event = this.parseWebhookPayload(rawPayload);
    if (!event) {
      return { event: null, item: null, isDuplicate: false };
    }

    const { item, isDuplicate } = await repo.enqueueInboxItem({
      messageId: event.wamid,
      senderPhone: event.from,
      rawPayload,
    });

    return { event, item, isDuplicate };
  }

  /**
   * Parse a batch of inbound events from a Meta Webhook body
   */
  public static parseMetaWebhookPayload(body: Record<string, unknown>): InboundWhatsAppEvent[] {
    const entry = (body.entry as any[]) || [];
    const events: InboundWhatsAppEvent[] = [];

    // Check direct simulation format first
    const direct = this.parseWebhookPayload(body);
    if (direct && (body.wamid || body.from)) {
      events.push(direct);
      return events;
    }

    for (const ent of entry) {
      const changes = (ent.changes as any[]) || [];
      for (const ch of changes) {
        const value = ch.value;
        const messages = (value?.messages as any[]) || [];
        const contact = (value?.contacts as any[])?.[0];

        for (const msg of messages) {
          const simulatedPayload = {
            entry: [
              {
                changes: [
                  {
                    value: {
                      messages: [msg],
                      contacts: contact ? [contact] : [],
                    },
                  },
                ],
              },
            ],
          };
          const parsed = this.parseWebhookPayload(simulatedPayload);
          if (parsed) {
            events.push(parsed);
          }
        }
      }
    }
    return events;
  }

  /**
   * Enqueue a batch of parsed inbound events
   */
  public static async enqueueInboundEvents(
    events: InboundWhatsAppEvent[],
    repo: IPrintOSRepository
  ): Promise<number> {
    let count = 0;
    for (const event of events) {
      const { isDuplicate } = await repo.enqueueInboxItem({
        messageId: event.wamid,
        senderPhone: event.from,
        rawPayload: event.rawPayload,
      });
      if (!isDuplicate) {
        count++;
      }
    }
    return count;
  }
}
