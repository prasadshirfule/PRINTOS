import { describe, it, expect, afterEach } from 'vitest';
import { getRepository, setRepository } from '@/lib/repository';

describe('Production Fail-Fast Configuration Guard', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    setRepository(null);
  });

  it('throws an explicit configuration error in production if Supabase credentials are missing', () => {
    setRepository(null);
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => getRepository()).toThrowError(/CRITICAL CONFIGURATION ERROR/);
  });

  it('allows in-memory repository fallback in development or test environments', () => {
    setRepository(null);
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => getRepository()).not.toThrow();
  });
});