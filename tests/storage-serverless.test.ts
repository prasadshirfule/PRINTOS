import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import {
  LocalStorageService,
  SupabaseStorageService,
  getStorageBucket,
  getStorageService,
  setStorageService,
  DEFAULT_STORAGE_BUCKET,
} from '@/lib/storage/storage-service';
import { WhatsAppWorkerEngine } from '@/lib/whatsapp/worker-engine';
import { InMemoryPrintOSRepository } from '@/lib/repository/in-memory-repository';
import { WhatsAppMediaDownloader } from '@/lib/whatsapp/media-downloader';
import { setWhatsAppProvider } from '@/lib/whatsapp/provider';
import { MockWhatsAppProvider } from '@/lib/whatsapp/provider/mock-whatsapp-provider';

describe('Serverless Storage Hardening & Supabase Bucket Config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    setStorageService(null);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setStorageService(null);
    vi.restoreAllMocks();
  });

  it('uses default bucket name print-documents', () => {
    delete process.env.PRINTOS_STORAGE_BUCKET;
    expect(DEFAULT_STORAGE_BUCKET).toBe('print-documents');
    expect(getStorageBucket()).toBe('print-documents');
  });

  it('allows overriding bucket name via PRINTOS_STORAGE_BUCKET env var', () => {
    process.env.PRINTOS_STORAGE_BUCKET = 'custom-shop-bucket';
    expect(getStorageBucket()).toBe('custom-shop-bucket');
  });

  it('does not eagerly create directories or throw during LocalStorageService construction in serverless', () => {
    process.env.VERCEL = '1';
    (process.env as Record<string, string>).NODE_ENV = 'production';

    // Instantiation must never throw even on read-only file systems
    expect(() => new LocalStorageService()).not.toThrow();

    const storage = new LocalStorageService();
    const expectedPrefix = path.join(os.tmpdir(), 'printos-documents');
    expect(storage.getLocalFilePath('test.pdf')).toContain(expectedPrefix);
  });

  it('instantiates WhatsAppWorkerEngine and runs cron cycle for text messages ("Hi") without disk storage dependency', async () => {
    // Simulate Vercel serverless environment
    process.env.VERCEL = '1';
    (process.env as Record<string, string>).NODE_ENV = 'production';

    const repo = new InMemoryPrintOSRepository();
    const mockProvider = new MockWhatsAppProvider();
    setWhatsAppProvider(mockProvider);

    // Enqueue a simple "Hi" text message
    await repo.enqueueInboxItem({
      messageId: 'wamid_text_hi_123',
      senderPhone: '919876543210',
      rawPayload: {
        type: 'text',
        text: 'Hi',
      },
    });

    const worker = new WhatsAppWorkerEngine(repo);
    const result = await worker.runCycle(10, 120);

    expect(result.inboxClaimed).toBe(1);
    expect(result.inboxProcessed).toBe(1);
    expect(result.inboxFailed).toBe(0);

    // An outbox response should be generated and sent
    expect(result.outboxClaimed).toBeGreaterThanOrEqual(1);
    expect(result.outboxSent).toBeGreaterThanOrEqual(1);
  });

  it('selects SupabaseStorageService when Supabase environment variables are present', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://real-project.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-secret-123';

    const storage = getStorageService();
    expect(storage).toBeInstanceOf(SupabaseStorageService);
  });

  it('WhatsAppMediaDownloader uses configured storage service without eager filesystem side-effects', () => {
    expect(() => new WhatsAppMediaDownloader()).not.toThrow();
  });
});
