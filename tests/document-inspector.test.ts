import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { DefaultDocumentInspector, DocumentInspectionError } from '@/lib/storage/document-inspector';

describe('Document Inspector & Validation Abstraction', () => {
  const inspector = new DefaultDocumentInspector(52428800, ['pdf', 'jpg', 'jpeg', 'png']);

  it('inspects and validates a generated multi-page PDF document', async () => {
    // Generate a simple 3-page PDF in memory using pdf-lib
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]); // A4 portrait
    pdfDoc.addPage([595, 842]);
    pdfDoc.addPage([595, 842]);
    const pdfBytes = await pdfDoc.save();
    const buffer = Buffer.from(pdfBytes);

    const result = await inspector.inspect(buffer, 'test-document.pdf');
    expect(result.fileType).toBe('pdf');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.pageCount).toBe(3);
    expect(result.width).toBe(595);
    expect(result.height).toBe(842);
    expect(result.orientation).toBe('PORTRAIT');
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('inspects a PNG image header and extracts dimensions', async () => {
    // Construct a minimal valid 24-byte PNG buffer with dimensions 800x600
    const pngBuffer = Buffer.alloc(24);
    // PNG signature
    pngBuffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    // IHDR chunk: width 800 at offset 16, height 600 at offset 20
    pngBuffer.writeUInt32BE(800, 16);
    pngBuffer.writeUInt32BE(600, 20);

    const result = await inspector.inspect(pngBuffer, 'diagram.png');
    expect(result.fileType).toBe('png');
    expect(result.mimeType).toBe('image/png');
    expect(result.pageCount).toBe(1);
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(result.orientation).toBe('LANDSCAPE');
  });

  it('rejects empty files (0 bytes)', async () => {
    const emptyBuffer = Buffer.alloc(0);
    await expect(inspector.inspect(emptyBuffer, 'empty.pdf')).rejects.toThrowError(
      DocumentInspectionError
    );
  });

  it('rejects unsupported file extensions (e.g., .exe, .docx)', async () => {
    const dummyBuffer = Buffer.from('dummy content');
    await expect(inspector.inspect(dummyBuffer, 'malware.exe')).rejects.toThrowError(
      DocumentInspectionError
    );
    await expect(inspector.inspect(dummyBuffer, 'notes.docx')).rejects.toThrowError(
      DocumentInspectionError
    );
  });

  it('rejects files that exceed maximum size limit', async () => {
    const smallInspector = new DefaultDocumentInspector(1024, ['pdf']); // 1KB limit
    const largeBuffer = Buffer.alloc(2048);
    await expect(smallInspector.inspect(largeBuffer, 'large.pdf')).rejects.toThrowError(
      DocumentInspectionError
    );
  });
});
