import { describe, it, expect } from 'vitest';
import { ProductionEnvValidator } from '@/lib/config/env-validator';

describe('Production Environment Validator', () => {
  it('passes in test/development mode with warnings for in-memory fallbacks', () => {
    const result = ProductionEnvValidator.validate({
      NODE_ENV: 'development',
    });

    expect(result.isValid).toBe(true);
    expect(result.missing.length).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('detects missing critical credentials in production mode', () => {
    const result = ProductionEnvValidator.validate({
      NODE_ENV: 'production',
      // Missing SUPABASE_URL, SERVICE_ROLE_KEY, AGENT_KEY
    });

    expect(result.isValid).toBe(false);
    expect(result.missing).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(result.missing).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(result.missing).toContain('PRINTOS_AGENT_KEY');
  });

  it('validates a complete production environment configuration', () => {
    const validEnv = {
      NODE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'https://prod-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'eyProdServiceRoleToken...',
      PRINTOS_AGENT_KEY: 'prod-agent-strong-secret-token-999',
      ADMIN_JWT_SECRET: 'super-secure-production-jwt-secret-999',
      ADMIN_EMAIL: 'shop-admin@printos.io',
      ADMIN_PASSWORD: 'complex-secure-prod-password-456',
      CRON_SECRET: 'prod-cron-secret-123456789',
      PAYMENT_PROVIDER: 'razorpay',
      RAZORPAY_KEY_ID: 'rzp_live_123',
      RAZORPAY_KEY_SECRET: 'rzp_sec_456',
      RAZORPAY_WEBHOOK_SECRET: 'rzp_wh_789',
      WHATSAPP_PROVIDER: 'openwa',
      OPENWA_API_URL: 'http://localhost:2785',
    };

    const result = ProductionEnvValidator.validate(validEnv);
    expect(result.isValid).toBe(true);
    expect(result.missing.length).toBe(0);
    expect(() => ProductionEnvValidator.assertProductionEnv(validEnv)).not.toThrow();
  });

  it('rejects default insecure credentials in production mode', () => {
    const insecureEnv = {
      NODE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'https://prod-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'eyProdServiceRoleToken...',
      PRINTOS_AGENT_KEY: 'mock-agent-secret-token',
      ADMIN_PASSWORD: 'admin123',
      ADMIN_JWT_SECRET: 'printos_default_secure_auth_key_123',
      CRON_SECRET: 'dev-cron-secret-123456789',
    };

    const result = ProductionEnvValidator.validate(insecureEnv);
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('throws an explicit error in assertProductionEnv when production config is incomplete', () => {
    expect(() =>
      ProductionEnvValidator.assertProductionEnv({
        NODE_ENV: 'production',
      })
    ).toThrowError(/CRITICAL PRODUCTION CONFIGURATION ERROR/);
  });

  it('rejects default ADMIN_EMAIL "admin@printos.local" in production mode', () => {
    const envWithDefaultEmail = {
      NODE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'https://prod-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'eyProdServiceRoleToken...',
      PRINTOS_AGENT_KEY: 'prod-agent-strong-secret-token-999',
      ADMIN_JWT_SECRET: 'super-secure-production-jwt-secret-999',
      ADMIN_EMAIL: 'admin@printos.local',
      ADMIN_PASSWORD: 'complex-secure-prod-password-456',
      CRON_SECRET: 'prod-cron-secret-123456789',
    };

    const result = ProductionEnvValidator.validate(envWithDefaultEmail);
    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ADMIN_EMAIL'),
      ])
    );
  });

  it('rejects placeholder secrets copied verbatim from documentation', () => {
    const envWithPlaceholders = {
      NODE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'https://prod-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'eyProdServiceRoleToken...',
      PRINTOS_AGENT_KEY: 'prod-agent-strong-secret-token-999',
      ADMIN_EMAIL: 'real-admin@shop.com',
      ADMIN_PASSWORD: 'complex-secure-prod-password-456',
      ADMIN_JWT_SECRET: 'your-secure-admin-session-secret',
      CRON_SECRET: 'your-secure-cron-secret-token',
    };

    const result = ProductionEnvValidator.validate(envWithPlaceholders);
    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ADMIN_JWT_SECRET'),
      ])
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('CRON_SECRET'),
      ])
    );
  });
});
