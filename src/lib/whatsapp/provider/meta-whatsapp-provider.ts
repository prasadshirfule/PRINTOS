import { Readable } from 'stream';
import { IWhatsAppProvider, WhatsAppButton } from '@/types/whatsapp';

export interface MetaWhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  apiVersion?: string;
}

export class MetaWhatsAppProvider implements IWhatsAppProvider {
  private phoneNumberId: string;
  private accessToken: string;
  private apiVersion: string;
  private baseUrl: string;

  constructor(config?: MetaWhatsAppConfig) {
    this.phoneNumberId = config?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
    this.accessToken = config?.accessToken || process.env.WHATSAPP_ACCESS_TOKEN || '';
    this.apiVersion = config?.apiVersion || process.env.WHATSAPP_GRAPH_API_VERSION || 'v20.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;

    if (!this.phoneNumberId || !this.accessToken) {
      // Warning logged if instantiated in production without keys
      if (process.env.NODE_ENV === 'production') {
        console.warn('[MetaWhatsAppProvider] Initialized without credentials in production.');
      }
    }
  }

  private get authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  public async sendText(to: string, message: string): Promise<{ providerMessageId: string }> {
    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.formatPhone(to),
      type: 'text',
      text: {
        preview_url: false,
        body: message,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Meta WhatsApp API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { messages?: Array<{ id: string }> };
    const providerMessageId = data.messages?.[0]?.id || `wamid_${Date.now()}`;
    return { providerMessageId };
  }

  public async sendInteractiveButtons(
    to: string,
    message: string,
    buttons: WhatsAppButton[],
    headerText?: string,
    footerText?: string
  ): Promise<{ providerMessageId: string }> {
    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
    
    // Meta allows max 3 buttons in interactive quick-reply format
    const formattedButtons = buttons.slice(0, 3).map((b) => ({
      type: 'reply',
      reply: {
        id: b.id,
        title: b.title.substring(0, 20), // Meta 20 character limit on button titles
      },
    }));

    const interactivePayload: Record<string, unknown> = {
      type: 'button',
      body: { text: message },
      action: { buttons: formattedButtons },
    };

    if (headerText) {
      interactivePayload.header = {
        type: 'text',
        text: headerText,
      };
    }

    if (footerText) {
      interactivePayload.footer = {
        text: footerText,
      };
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.formatPhone(to),
      type: 'interactive',
      interactive: interactivePayload,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Meta WhatsApp API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { messages?: Array<{ id: string }> };
    const providerMessageId = data.messages?.[0]?.id || `wamid_${Date.now()}`;
    return { providerMessageId };
  }

  public async sendDocument(
    to: string,
    documentUrl: string,
    filename: string,
    caption?: string
  ): Promise<{ providerMessageId: string }> {
    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.formatPhone(to),
      type: 'document',
      document: {
        link: documentUrl,
        filename,
        caption,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Meta WhatsApp API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { messages?: Array<{ id: string }> };
    const providerMessageId = data.messages?.[0]?.id || `wamid_${Date.now()}`;
    return { providerMessageId };
  }

  public async getMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string; fileSize?: number }> {
    const url = `${this.baseUrl}/${mediaId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Meta WhatsApp getMedia error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { url: string; mime_type: string; file_size?: number };
    return {
      url: data.url,
      mimeType: data.mime_type,
      fileSize: data.file_size,
    };
  }

  public async downloadMediaStream(
    mediaUrl: string
  ): Promise<{ stream: NodeJS.ReadableStream; contentLength?: number }> {
    const response = await fetch(mediaUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => 'No body');
      throw new Error(`Meta WhatsApp downloadMedia error (${response.status}): ${errorText}`);
    }

    const contentLengthHeader = response.headers.get('content-length');
    const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;

    // Convert Web ReadableStream to Node.js Readable stream
    const nodeStream = Readable.fromWeb(response.body as import('stream/web').ReadableStream);
    return { stream: nodeStream, contentLength };
  }

  private formatPhone(phone: string): string {
    // Strip leading '+' or non-digit characters
    return phone.replace(/\D/g, '');
  }
}
