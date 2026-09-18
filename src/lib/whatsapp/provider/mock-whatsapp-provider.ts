import { Readable } from 'stream';
import { IWhatsAppProvider, WhatsAppButton } from '@/types/whatsapp';

export interface SentWhatsAppMessageRecord {
  to: string;
  type: 'text' | 'interactive' | 'document';
  message?: string;
  buttons?: WhatsAppButton[];
  headerText?: string;
  footerText?: string;
  documentUrl?: string;
  filename?: string;
  caption?: string;
  sentAt: number;
  providerMessageId: string;
}

export class MockWhatsAppProvider implements IWhatsAppProvider {
  public sentMessages: SentWhatsAppMessageRecord[] = [];
  private mediaStore: Map<string, { buffer: Buffer; mimeType: string; filename: string }> = new Map();
  public shouldFail = false;
  public failureError = new Error('Mock WhatsApp Provider intentional failure');

  public setMockMedia(mediaId: string, buffer: Buffer, mimeType: string, filename: string): void {
    this.mediaStore.set(mediaId, { buffer, mimeType, filename });
  }

  public clear(): void {
    this.sentMessages = [];
    this.mediaStore.clear();
    this.shouldFail = false;
  }

  public async sendText(to: string, message: string): Promise<{ providerMessageId: string }> {
    if (this.shouldFail) throw this.failureError;
    const providerMessageId = `mock_wamid_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    this.sentMessages.push({
      to,
      type: 'text',
      message,
      sentAt: Date.now(),
      providerMessageId,
    });
    return { providerMessageId };
  }

  public async sendInteractiveButtons(
    to: string,
    message: string,
    buttons: WhatsAppButton[],
    headerText?: string,
    footerText?: string
  ): Promise<{ providerMessageId: string }> {
    if (this.shouldFail) throw this.failureError;
    const providerMessageId = `mock_wamid_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    this.sentMessages.push({
      to,
      type: 'interactive',
      message,
      buttons,
      headerText,
      footerText,
      sentAt: Date.now(),
      providerMessageId,
    });
    return { providerMessageId };
  }

  public async sendDocument(
    to: string,
    documentUrl: string,
    filename: string,
    caption?: string
  ): Promise<{ providerMessageId: string }> {
    if (this.shouldFail) throw this.failureError;
    const providerMessageId = `mock_wamid_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    this.sentMessages.push({
      to,
      type: 'document',
      documentUrl,
      filename,
      caption,
      sentAt: Date.now(),
      providerMessageId,
    });
    return { providerMessageId };
  }

  public async getMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string; fileSize?: number }> {
    if (this.shouldFail) throw this.failureError;
    const item = this.mediaStore.get(mediaId);
    if (item) {
      return {
        url: `https://mock-whatsapp.internal/media/${mediaId}`,
        mimeType: item.mimeType,
        fileSize: item.buffer.length,
      };
    }
    return {
      url: `https://mock-whatsapp.internal/media/${mediaId}`,
      mimeType: 'application/pdf',
      fileSize: 1024,
    };
  }

  public async downloadMediaStream(
    mediaUrl: string
  ): Promise<{ stream: NodeJS.ReadableStream; contentLength?: number }> {
    if (this.shouldFail) throw this.failureError;
    const mediaId = mediaUrl.split('/').pop() || '';
    const item = this.mediaStore.get(mediaId);
    if (item) {
      const readable = Readable.from(item.buffer);
      return { stream: readable, contentLength: item.buffer.length };
    }
    // Default minimal mock PDF buffer (%PDF-1.4 header)
    const defaultPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
    return { stream: Readable.from(defaultPdf), contentLength: defaultPdf.length };
  }
}
