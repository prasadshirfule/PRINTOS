import { Readable } from 'stream';
import { IWhatsAppProvider, WhatsAppButton } from '@/types/whatsapp';

export interface OpenWAConfig {
  baseUrl?: string;
  apiKey?: string;
  sessionId?: string;
}

export class OpenWAWhatsAppProvider implements IWhatsAppProvider {
  private baseUrl: string;
  private apiKey: string;
  private sessionId: string;

  constructor(config?: OpenWAConfig) {
    this.baseUrl = (config?.baseUrl || process.env.OPENWA_BASE_URL || 'http://127.0.0.1:2785').replace(/\/+$/, '');
    this.apiKey = config?.apiKey || process.env.OPENWA_API_KEY || '';
    this.sessionId = config?.sessionId || process.env.OPENWA_SESSION_ID || 'session-printos';

    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction && (!this.apiKey || !this.baseUrl || !this.sessionId)) {
      throw new Error(
        '[PRINTOS] OpenWAWhatsAppProvider missing required configuration in production (OPENWA_BASE_URL, OPENWA_API_KEY, OPENWA_SESSION_ID).'
      );
    }
  }

  private get authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }
    return headers;
  }

  private formatChatId(phone: string): string {
    const cleaned = phone.replace(/@c\.us$/, '').replace(/\D/g, '');
    return `${cleaned}@c.us`;
  }

  public async sendText(to: string, message: string): Promise<{ providerMessageId: string }> {
    const endpoint = `${this.baseUrl}/api/sessions/${encodeURIComponent(this.sessionId)}/messages/send-text`;
    const chatId = this.formatChatId(to);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify({
          chatId,
          text: message,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'No error body');
        throw new Error(`OpenWA sendText error (${response.status}): ${errorText}`);
      }

      const resData = (await response.json().catch(() => ({}))) as { id?: string; messageId?: string };
      const providerMessageId = resData.id || resData.messageId || `openwa_${Date.now()}`;
      return { providerMessageId };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('OpenWA sendText request timed out after 15s');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async sendInteractiveButtons(
    to: string,
    message: string,
    buttons: WhatsAppButton[],
    headerText?: string,
    footerText?: string
  ): Promise<{ providerMessageId: string }> {
    // OpenWA / WhatsApp Web protocol does not render Meta quick-reply buttons.
    // We format a structured, deterministic numbered menu fallback for text interaction.
    const headerPart = headerText ? `*${headerText}*\n\n` : '';
    const footerPart = footerText ? `\n\n_${footerText}_` : '';
    const menuOptions = buttons.map((b, i) => `${i + 1}️⃣ ${b.title}`).join('\n');
    const formattedText = `${headerPart}${message}\n\n${menuOptions}${footerPart}\n\n_Reply with the number (e.g. 1) or option name._`;

    return this.sendText(to, formattedText);
  }

  public async sendDocument(
    to: string,
    documentUrl: string,
    filename: string,
    caption?: string
  ): Promise<{ providerMessageId: string }> {
    const endpoint = `${this.baseUrl}/api/sessions/${encodeURIComponent(this.sessionId)}/messages/send-document`;
    const chatId = this.formatChatId(to);

    const isHttpUrl = documentUrl.startsWith('http://') || documentUrl.startsWith('https://');
    const isBase64 = documentUrl.startsWith('data:') || !isHttpUrl;
    const base64Data = isBase64 ? documentUrl.replace(/^data:[^;]+;base64,/, '') : undefined;

    const payload: Record<string, unknown> = {
      chatId,
      filename: filename || 'document.pdf',
      mimetype: filename.endsWith('.pdf')
        ? 'application/pdf'
        : filename.endsWith('.png')
        ? 'image/png'
        : 'image/jpeg',
      caption: caption || '',
    };

    if (isHttpUrl) {
      payload.url = documentUrl;
    } else {
      payload.base64 = base64Data;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'No error body');
        throw new Error(`OpenWA sendDocument error (${response.status}): ${errorText}`);
      }

      const resData = (await response.json().catch(() => ({}))) as { id?: string; messageId?: string };
      const providerMessageId = resData.id || resData.messageId || `openwa_${Date.now()}`;
      return { providerMessageId };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('OpenWA sendDocument request timed out after 20s');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async getMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string; fileSize?: number }> {
    // In OpenWA, mediaId is either the message ID (e.g. false_919876543210@c.us_3EB0...)
    // or a full REST endpoint URL.
    if (mediaId.startsWith('http://') || mediaId.startsWith('https://')) {
      return { url: mediaId, mimeType: 'application/octet-stream' };
    }

    // Extract chatId from messageId if present (format: [fromMe]_[chatId]_[id])
    const parts = mediaId.split('_');
    const chatId = parts.length >= 3 ? parts[1] : `${this.sessionId}@c.us`;
    const messageId = parts.length >= 3 ? parts[2] : mediaId;

    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(this.sessionId)}/messages/${encodeURIComponent(
      chatId
    )}/${encodeURIComponent(messageId)}/media`;

    return {
      url,
      mimeType: 'application/octet-stream',
    };
  }

  public async downloadMediaStream(
    mediaUrl: string
  ): Promise<{ stream: NodeJS.ReadableStream; contentLength?: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(mediaUrl, {
        method: 'GET',
        headers: this.authHeaders,
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const errorText = await response.text().catch(() => 'No body');
        throw new Error(`OpenWA downloadMedia error (${response.status}): ${errorText}`);
      }

      const contentLengthHeader = response.headers.get('content-length');
      const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;

      const nodeStream = Readable.fromWeb(response.body as import('stream/web').ReadableStream);
      return { stream: nodeStream, contentLength };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('OpenWA downloadMedia request timed out after 30s');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
