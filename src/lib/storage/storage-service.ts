import fs from 'fs';
import path from 'path';

export interface IStorageService {
  uploadDocument(storagePath: string, buffer: Buffer, contentType: string): Promise<string>;
  createSignedUrl(storagePath: string, expiresInSeconds?: number): Promise<string>;
  deleteDocument(storagePath: string): Promise<void>;
}

/**
 * Local filesystem-backed private storage service for local development / testing.
 * Files are kept private in a secure local directory, and signed URLs are simulated
 * with tokenized temporary local access endpoints.
 */
export class LocalStorageService implements IStorageService {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.resolve(process.cwd(), '.storage', 'print-documents');
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public async uploadDocument(storagePath: string, buffer: Buffer): Promise<string> {
    const fullPath = path.join(this.baseDir, storagePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await fs.promises.writeFile(fullPath, buffer);
    return storagePath;
  }

  public async createSignedUrl(storagePath: string, expiresInSeconds = 300): Promise<string> {
    // Generates a mock signed URL with an expiration timestamp and token
    const token = Buffer.from(`${storagePath}:${Date.now() + expiresInSeconds * 1000}`).toString('base64url');
    return `/api/agent/documents/download?path=${encodeURIComponent(storagePath)}&token=${token}`;
  }

  public async deleteDocument(storagePath: string): Promise<void> {
    const fullPath = path.join(this.baseDir, storagePath);
    if (fs.existsSync(fullPath)) {
      await fs.promises.unlink(fullPath);
    }
  }

  public getLocalFilePath(storagePath: string): string {
    return path.join(this.baseDir, storagePath);
  }
}
