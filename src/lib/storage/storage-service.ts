import fs from 'fs';
import path from 'path';
import os from 'os';
import { createClient } from '@supabase/supabase-js';

export const DEFAULT_STORAGE_BUCKET = 'print-documents';

export function getStorageBucket(): string {
  return process.env.PRINTOS_STORAGE_BUCKET || DEFAULT_STORAGE_BUCKET;
}

export function isSupabaseStorageConfigured(): boolean {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(supabaseUrl && serviceRoleKey) && !supabaseUrl?.includes('your-supabase-project');
}

export interface IStorageService {
  uploadDocument(storagePath: string, buffer: Buffer, contentType: string): Promise<string>;
  createSignedUrl(storagePath: string, expiresInSeconds?: number): Promise<string>;
  deleteDocument(storagePath: string): Promise<void>;
  verifyDocumentExists?(storagePath: string): Promise<boolean>;
}

export class SupabaseStorageService implements IStorageService {
  private bucket: string;

  constructor(bucket?: string) {
    this.bucket = bucket || getStorageBucket();
  }

  private getClient() {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error('Supabase storage requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    }
    return createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
  }

  public async uploadDocument(storagePath: string, buffer: Buffer, contentType: string): Promise<string> {
    const supabase = this.getClient();
    const { error } = await supabase.storage
      .from(this.bucket)
      .upload(storagePath, buffer, {
        contentType,
        upsert: true,
      });

    if (error) {
      throw new Error(`Failed to upload media to Supabase storage (${this.bucket}): ${error.message}`);
    }

    return storagePath;
  }

  public async createSignedUrl(storagePath: string, expiresInSeconds = 300): Promise<string> {
    const supabase = this.getClient();
    const { data, error } = await supabase.storage
      .from(this.bucket)
      .createSignedUrl(storagePath, expiresInSeconds);

    if (error || !data?.signedUrl) {
      throw new Error(`Failed to generate signed document URL (${this.bucket}): ${error?.message || 'Storage error'}`);
    }

    return data.signedUrl;
  }

  public async deleteDocument(storagePath: string): Promise<void> {
    const supabase = this.getClient();
    const { error } = await supabase.storage
      .from(this.bucket)
      .remove([storagePath]);

    if (error) {
      throw new Error(`Failed to delete document from Supabase storage (${this.bucket}): ${error.message}`);
    }
  }

  public async verifyDocumentExists(storagePath: string): Promise<boolean> {
    if (!storagePath) return false;
    try {
      const supabase = this.getClient();
      const parts = storagePath.split('/');
      const folder = parts.slice(0, -1).join('/');
      const filename = parts[parts.length - 1];
      const { data, error } = await supabase.storage
        .from(this.bucket)
        .list(folder, { search: filename, limit: 1 });
      return !error && Boolean(data && data.length > 0);
    } catch {
      return false;
    }
  }
}

/**
 * Local filesystem-backed private storage service for local development / testing.
 * Files are kept in a local directory (or OS temp directory in serverless environments).
 * Signed URLs are simulated with tokenized temporary local access endpoints.
 */
export class LocalStorageService implements IStorageService {
  private baseDir: string;

  constructor(baseDir?: string) {
    if (baseDir) {
      this.baseDir = baseDir;
    } else {
      const isServerless = Boolean(
        process.env.VERCEL ||
        process.env.AWS_LAMBDA_FUNCTION_NAME ||
        process.env.NODE_ENV === 'production'
      );
      if (isServerless) {
        this.baseDir = path.join(os.tmpdir(), 'printos-documents');
      } else {
        this.baseDir = path.resolve(process.cwd(), '.storage', 'print-documents');
      }
    }
    // Eager mkdir removed to prevent startup crashes on read-only serverless filesystems
  }

  private ensureDir(targetDir: string): void {
    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
    } catch (err) {
      // In serverless, if project-relative mkdir fails, fallback to os.tmpdir()
      const fallbackDir = path.join(os.tmpdir(), 'printos-documents');
      if (this.baseDir !== fallbackDir) {
        this.baseDir = fallbackDir;
        const fallbackTarget = path.join(this.baseDir, path.relative(this.baseDir, targetDir));
        if (!fs.existsSync(fallbackTarget)) {
          fs.mkdirSync(fallbackTarget, { recursive: true });
        }
      } else {
        console.warn(`[LocalStorageService] Could not create directory ${targetDir}:`, err);
      }
    }
  }

  public async uploadDocument(storagePath: string, buffer: Buffer, _contentType?: string): Promise<string> {
    const fullPath = path.join(this.baseDir, storagePath);
    const dir = path.dirname(fullPath);
    this.ensureDir(dir);
    await fs.promises.writeFile(fullPath, buffer);
    return storagePath;
  }

  public async createSignedUrl(storagePath: string, expiresInSeconds = 300): Promise<string> {
    // Generates a mock signed URL with an expiration timestamp and token
    const token = Buffer.from(`${storagePath}:${Date.now() + expiresInSeconds * 1000}`).toString('base64url');
    return `/api/agent/documents/download?path=${encodeURIComponent(storagePath)}&token=${token}`;
  }

  public async deleteDocument(storagePath: string): Promise<void> {
    try {
      const fullPath = path.join(this.baseDir, storagePath);
      if (fs.existsSync(fullPath)) {
        await fs.promises.unlink(fullPath);
      }
    } catch {
      // Ignore deletion failure if file doesn't exist
    }
  }

  public getLocalFilePath(storagePath: string): string {
    return path.join(this.baseDir, storagePath);
  }

  public async verifyDocumentExists(storagePath: string): Promise<boolean> {
    try {
      const fullPath = path.join(this.baseDir, storagePath);
      return fs.existsSync(fullPath);
    } catch {
      return false;
    }
  }
}

let activeStorageService: IStorageService | null = null;

export function getStorageService(): IStorageService {
  if (activeStorageService) {
    return activeStorageService;
  }
  if (isSupabaseStorageConfigured()) {
    return new SupabaseStorageService();
  }
  return new LocalStorageService();
}

export function setStorageService(service: IStorageService | null): void {
  activeStorageService = service;
}
