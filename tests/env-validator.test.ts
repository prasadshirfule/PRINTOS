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
      CRON_SECRET: 'prod-cron-secret-12345',
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

  it('throws an explicit error in assertProductionEnv when production config is incomplete', () => {
    expect(() =>
      ProductionEnvValidator.assertProductionEnv({
        NODE_ENV: 'production',
      })
    ).toThrowError(/CRITICAL PRODUCTION CONFIGURATION ERROR/);
  });
});
