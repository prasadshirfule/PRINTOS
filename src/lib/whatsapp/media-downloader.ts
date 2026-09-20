import { IWhatsAppProvider } from '@/types/whatsapp';
import { DefaultDocumentInspector, DocumentInspectionResult } from '@/lib/storage/document-inspector';
import { getStorageService, IStorageService } from '@/lib/storage/storage-service';
import crypto from 'crypto';

export const MAX_MEDIA_FILE_SIZE_BYTES = 52428800; // 50MB

export interface IngestedMediaResult {
  storagePath: string;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
  pageCount: number;
  fileType: 'pdf' | 'jpg' | 'jpeg' | 'png';
}

export class MediaIngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaIngestionError';
  }
}

export function detectMagicBytes(buffer: Buffer): 'pdf' | 'jpg' | 'png' | null {
  if (buffer.length < 4) return null;

  // PDF: %PDF- (0x25 0x50 0x44 0x46 0x2D)
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    (buffer.length < 5 || buffer[4] === 0x2d)
  ) {
    return 'pdf';
  }

  // PNG: \x89PNG (0x89 0x50 0x4E 0x47)
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'jpg';
  }

  return null;
}

export class WhatsAppMediaDownloader {
  private inspector: DefaultDocumentInspector;
  private customStorageService?: IStorageService;

  constructor(customStorageService?: IStorageService) {
    this.inspector = new DefaultDocumentInspector(MAX_MEDIA_FILE_SIZE_BYTES);
    this.customStorageService = customStorageService;
  }

  private getStorage(): IStorageService {
    return this.customStorageService || getStorageService();
  }

  /**
   * Ingests media either from inline base64 (small OpenWA media) or via streaming download
   * from the WhatsApp provider (Meta Cloud API or OpenWA REST endpoint) with a 50MB hard limit.
   * Validates magic-bytes, extracts page count, and persists into private Supabase Storage.
   */
  public async ingestMedia(
    provider: IWhatsAppProvider,
    mediaId: string,
    providedFilename?: string,
    customerPhone?: string,
    inlineBase64?: string
  ): Promise<IngestedMediaResult> {
    let fullBuffer: Buffer;

    // CASE A: Direct inline base64 media payload (e.g. OpenWA <= 1MB payloads)
    if (inlineBase64 && typeof inlineBase64 === 'string') {
      const cleanBase64 = inlineBase64.replace(/^data:[^;]+;base64,/, '');
      fullBuffer = Buffer.from(cleanBase64, 'base64');

      if (fullBuffer.length > MAX_MEDIA_FILE_SIZE_BYTES) {
        throw new MediaIngestionError(
          `File size (${(fullBuffer.length / (1024 * 1024)).toFixed(1)}MB) exceeds maximum limit of 50MB.`
        );
      }
    } else {
      // CASE B: Provider streaming download (Meta CDN or OpenWA /media REST endpoint)
      const { url: mediaUrl } = await provider.getMediaUrl(mediaId);
      const { stream, contentLength } = await provider.downloadMediaStream(mediaUrl);

      if (contentLength && contentLength > MAX_MEDIA_FILE_SIZE_BYTES) {
        throw new MediaIngestionError(
          `File size (${(contentLength / (1024 * 1024)).toFixed(1)}MB) exceeds maximum limit of 50MB.`
        );
      }

      const chunks: Buffer[] = [];
      let downloadedBytes = 0;

      for await (const chunk of stream) {
        const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        downloadedBytes += bufferChunk.length;

        if (downloadedBytes > MAX_MEDIA_FILE_SIZE_BYTES) {
          throw new MediaIngestionError('File exceeded 50MB size limit during streaming download.');
        }
        chunks.push(bufferChunk);
      }

      fullBuffer = Buffer.concat(chunks);
    }

    if (fullBuffer.length === 0) {
      throw new MediaIngestionError('Downloaded document is empty (0 bytes).');
    }

    // 1. Magic-Byte Validation (Never trust MIME type or extension alone)
    const detectedType = detectMagicBytes(fullBuffer);
    if (!detectedType) {
      throw new MediaIngestionError(
        'Document validation failed: Unrecognized file signature. Only valid PDF, JPEG, and PNG files are allowed.'
      );
    }

    // Determine normalized extension and filename
    const ext = detectedType === 'jpg' ? 'jpg' : detectedType;
    const sanitizedBase = (providedFilename || `document_${Date.now()}`)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.[^/.]+$/, '');
    const filename = `${sanitizedBase}.${ext}`;

    // 2. Document Inspection & Page Count Extraction
    const inspection: DocumentInspectionResult = await this.inspector.inspect(fullBuffer, filename);

    // 3. Store document into Private Storage
    const phonePrefix = (customerPhone || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const docUuid = crypto.randomUUID();
    const storagePath = `whatsapp/${phonePrefix}/${docUuid}_${filename}`;

    await this.saveToStorage(storagePath, fullBuffer, inspection.mimeType);

    return {
      storagePath,
      filename,
      mimeType: inspection.mimeType,
      fileSizeBytes: inspection.sizeBytes,
      pageCount: inspection.pageCount,
      fileType: inspection.fileType,
    };
  }

  private async saveToStorage(storagePath: string, buffer: Buffer, contentType: string): Promise<void> {
    try {
      await this.getStorage().uploadDocument(storagePath, buffer, contentType);
    } catch (err: unknown) {
      throw new MediaIngestionError(
        `Failed to upload media to storage: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
