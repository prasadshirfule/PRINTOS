import { PDFDocument } from 'pdf-lib';
import { FileType } from '@/types/printos';

export interface DocumentInspectionResult {
  fileType: FileType;
  mimeType: string;
  sizeBytes: number;
  pageCount: number;
  width?: number;
  height?: number;
  orientation?: 'PORTRAIT' | 'LANDSCAPE' | 'SQUARE';
}

export class DocumentInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentInspectionError';
  }
}

export interface IDocumentInspector {
  inspect(buffer: Buffer, filename: string): Promise<DocumentInspectionResult>;
}

export class DefaultDocumentInspector implements IDocumentInspector {
  private maxSizeBytes: number;
  private allowedTypes: FileType[];

  constructor(maxSizeBytes: number = 52428800, allowedTypes: FileType[] = ['pdf', 'jpg', 'jpeg', 'png']) {
    this.maxSizeBytes = maxSizeBytes;
    this.allowedTypes = allowedTypes;
  }

  public async inspect(buffer: Buffer, filename: string): Promise<DocumentInspectionResult> {
    const sizeBytes = buffer.length;

    if (sizeBytes === 0) {
      throw new DocumentInspectionError('Uploaded file is empty (0 bytes).');
    }

    if (sizeBytes > this.maxSizeBytes) {
      throw new DocumentInspectionError(
        `File size (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB) exceeds the maximum allowed limit of ${(
          this.maxSizeBytes / (1024 * 1024)
        ).toFixed(1)} MB.`
      );
    }

    const extension = filename.split('.').pop()?.toLowerCase() as FileType | undefined;
    if (!extension || !this.allowedTypes.includes(extension)) {
      throw new DocumentInspectionError(
        `Unsupported file type: "${extension}". Allowed types are: ${this.allowedTypes.join(', ')}.`
      );
    }

    if (extension === 'pdf') {
      return this.inspectPdf(buffer, sizeBytes);
    } else {
      return this.inspectImage(buffer, extension, sizeBytes);
    }
  }

  private async inspectPdf(buffer: Buffer, sizeBytes: number): Promise<DocumentInspectionResult> {
    try {
      // Load PDF document using pdf-lib
      const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const pageCount = pdfDoc.getPageCount();

      if (pageCount === 0) {
        throw new DocumentInspectionError('The PDF document contains 0 pages.');
      }

      const firstPage = pdfDoc.getPage(0);
      const { width, height } = firstPage.getSize();

      let orientation: 'PORTRAIT' | 'LANDSCAPE' | 'SQUARE' = 'PORTRAIT';
      if (width > height) {
        orientation = 'LANDSCAPE';
      } else if (width === height) {
        orientation = 'SQUARE';
      }

      return {
        fileType: 'pdf',
        mimeType: 'application/pdf',
        sizeBytes,
        pageCount,
        width: Math.round(width),
        height: Math.round(height),
        orientation,
      };
    } catch (err: unknown) {
      if (err instanceof DocumentInspectionError) {
        throw err;
      }
      throw new DocumentInspectionError(
        `Failed to parse PDF document: ${err instanceof Error ? err.message : 'Corrupted or unreadable PDF file.'}`
      );
    }
  }

  private inspectImage(buffer: Buffer, extension: FileType, sizeBytes: number): DocumentInspectionResult {
    const mimeType = extension === 'png' ? 'image/png' : 'image/jpeg';
    let width = 0;
    let height = 0;

    // Fast header inspection for PNG
    if (extension === 'png' && buffer.length >= 24) {
      width = buffer.readUInt32BE(16);
      height = buffer.readUInt32BE(20);
    }

    // Fast header inspection for JPEG
    if ((extension === 'jpg' || extension === 'jpeg') && buffer.length >= 2) {
      let offset = 2;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          height = buffer.readUInt16BE(offset + 5);
          width = buffer.readUInt16BE(offset + 7);
          break;
        }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
    }

    let orientation: 'PORTRAIT' | 'LANDSCAPE' | 'SQUARE' = 'PORTRAIT';
    if (width > 0 && height > 0) {
      if (width > height) orientation = 'LANDSCAPE';
      else if (width === height) orientation = 'SQUARE';
    }

    return {
      fileType: extension,
      mimeType,
      sizeBytes,
      pageCount: 1, // Images default to 1 printable page
      width: width || undefined,
      height: height || undefined,
      orientation,
    };
  }
}
