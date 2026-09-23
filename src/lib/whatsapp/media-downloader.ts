import { IWhatsAppProvider } from '@/types/whatsapp';
import { DefaultDocumentInspector, DocumentInspectionResult } from '@/lib/storage/document-inspector';
import { getStorageService, IStorageService } from '@/lib/storage/storage-service';
import { createLogger } from '@/lib/observability/logger';
import crypto from 'crypto';

const logger = createLogger('WhatsAppMediaDownloader');

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

/**
 * Robust file signature detection (magic-byte validation).
 * For PDF, searches within the first 1024 bytes per ISO 32000-1 §7.5.2 to handle
 * UTF-8 BOM, leading newlines, whitespace, or comments.
 */
export function detectMagicBytes(buffer: Buffer): 'pdf' | 'jpg' | 'png' | null {
  if (!buffer || buffer.length < 3) return null;

  // 1. PDF: Search for %PDF- in the first 1024 bytes (ISO 32000-1 §7.5.2)
  const searchLimit = Math.min(buffer.length, 1024);
  for (let i = 0; i <= searchLimit - 4; i++) {
    if (
      buffer[i] === 0x25 && // %
      buffer[i + 1] === 0x50 && // P
      buffer[i + 2] === 0x44 && // D
      buffer[i + 3] === 0x46 // F
    ) {
      return 'pdf';
    }
  }

  // 2. PNG: \x89PNG (0x89 0x50 0x4E 0x47)
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png';
  }

  // 3. JPEG: FF D8 FF
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'jpg';
  }

  return null;
}

/**
 * Normalizes incoming media buffers from OpenWA/Meta payloads.
 * Decodes JSON wrappers (e.g. {"data":"data:application/pdf;base64,..."}),
 * data URLs (data:application/pdf;base64,...), and ASCII base64 strings
 * into raw binary buffers before validation.
 */
export function normalizeMediaBuffer(input: Buffer | string): Buffer {
  let rawBuf: Buffer;

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const json = JSON.parse(trimmed);
        const dataStr =
          json.data ||
          json.base64 ||
          json.media ||
          (json.mediaData && json.mediaData.data) ||
          json.body;
        if (typeof dataStr === 'string') {
          return normalizeMediaBuffer(dataStr);
        }
      } catch {
        // Fallback to plain base64 decoding
      }
    }
    const cleanBase64 = trimmed.replace(/^data:[^;]+;base64,/, '');
    rawBuf = Buffer.from(cleanBase64, 'base64');
  } else {
    rawBuf = input;
  }

  // If already matches binary magic bytes, return as is
  if (detectMagicBytes(rawBuf)) {
    return rawBuf;
  }

  // Check if buffer is ASCII JSON
  const str = rawBuf.toString('utf8').trim();
  if (str.startsWith('{') && str.endsWith('}')) {
    try {
      const json = JSON.parse(str);
      const dataStr =
        json.data ||
        json.base64 ||
        json.media ||
        (json.mediaData && json.mediaData.data) ||
        json.body;
      if (typeof dataStr === 'string') {
        return normalizeMediaBuffer(dataStr);
      }
    } catch {
      // Not valid JSON
    }
  }

  // Check if buffer is ASCII Data URL
  if (str.startsWith('data:')) {
    const cleanBase64 = str.replace(/^data:[^;]+;base64,/, '');
    const decoded = Buffer.from(cleanBase64, 'base64');
    if (detectMagicBytes(decoded)) {
      return decoded;
    }
  }

  // Check if buffer is ASCII raw Base64 string
  if (str.startsWith('JVBERi') || str.startsWith('/9j/') || str.startsWith('iVBORw')) {
    const decoded = Buffer.from(str, 'base64');
    if (detectMagicBytes(decoded)) {
      return decoded;
    }
  }

  return rawBuf;
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
    inlineBase64?: string,
    declaredMimeType?: string,
    messageId?: string
  ): Promise<IngestedMediaResult> {
    const diag: Record<string, unknown> = {
      messageId: messageId || mediaId,
      mediaId,
      filename: providedFilename,
      declaredMimeType,
      httpStatus: undefined,
      responseContentType: undefined,
      downloadedByteCount: 0,
      detectedFileType: null,
      magicBytesHex: null,
      magicBytesAscii: null,
      pdfParsingStarted: false,
      pdfParsingSucceeded: false,
      extractedPageCount: 0,
    };

    try {
      let fullBuffer: Buffer;

      // CASE A: Direct inline base64 media payload (e.g. OpenWA inline payloads)
      if (inlineBase64 && typeof inlineBase64 === 'string') {
        fullBuffer = normalizeMediaBuffer(inlineBase64);

        if (fullBuffer.length > MAX_MEDIA_FILE_SIZE_BYTES) {
          throw new MediaIngestionError(
            `File size (${(fullBuffer.length / (1024 * 1024)).toFixed(1)}MB) exceeds maximum limit of 50MB.`
          );
        }
      } else {
        // CASE B: Provider streaming download (Meta CDN or OpenWA /media REST endpoint)
        const { url: mediaUrl, mimeType: fetchedMime } = await provider.getMediaUrl(mediaId);
        diag.declaredMimeType = declaredMimeType || fetchedMime;

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

        const rawConcatenated = Buffer.concat(chunks);
        fullBuffer = normalizeMediaBuffer(rawConcatenated);
      }

      if (fullBuffer.length > MAX_MEDIA_FILE_SIZE_BYTES) {
        throw new MediaIngestionError(
          `File size (${(fullBuffer.length / (1024 * 1024)).toFixed(1)}MB) exceeds maximum limit of 50MB.`
        );
      }

      diag.downloadedByteCount = fullBuffer.length;
      if (fullBuffer.length > 0) {
        diag.magicBytesHex = fullBuffer.subarray(0, 8).toString('hex');
        diag.magicBytesAscii = fullBuffer.subarray(0, 8).toString('ascii').replace(/[^\x20-\x7E]/g, '.');
      }

      if (fullBuffer.length === 0) {
        throw new MediaIngestionError('Downloaded document is empty (0 bytes).');
      }

      // 1. Magic-Byte Validation (Never trust MIME type or extension alone)
      const detectedType = detectMagicBytes(fullBuffer);
      diag.detectedFileType = detectedType;

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
      if (detectedType === 'pdf') {
        diag.pdfParsingStarted = true;
      }

      const inspection: DocumentInspectionResult = await this.inspector.inspect(fullBuffer, filename);

      if (detectedType === 'pdf') {
        diag.pdfParsingSucceeded = true;
        diag.extractedPageCount = inspection.pageCount;
      }

      // 3. Store document into Private Storage
      const phonePrefix = (customerPhone || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
      const docUuid = crypto.randomUUID();
      const storagePath = `whatsapp/${phonePrefix}/${docUuid}_${filename}`;

      await this.saveToStorage(storagePath, fullBuffer, inspection.mimeType);

      logger.info('Media ingestion completed successfully', diag);

      return {
        storagePath,
        filename,
        mimeType: inspection.mimeType,
        fileSizeBytes: inspection.sizeBytes,
        pageCount: inspection.pageCount,
        fileType: inspection.fileType,
      };
    } catch (err: unknown) {
      logger.error('Media ingestion diagnostic failure', {
        ...diag,
        errorName: err instanceof Error ? err.name : 'UnknownError',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
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
