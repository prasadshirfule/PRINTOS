export interface EnvValidationResult {
  isValid: boolean;
  missing: string[];
  warnings: string[];
  errors: string[];
}

export class ProductionEnvValidator {
  /**
   * Insecure default secrets that must never be used in production
   */
  private static readonly INSECURE_DEFAULTS = new Set([
    'mock-agent-secret-token',
    'dev-agent-key-secret-123456789',
    'printos_default_secure_auth_key_123',
    'dev-cron-secret-123456789',
    'your-secure-admin-session-secret',
    'your-secure-cron-secret-token',
    'admin123',
    'password',
    'secret',
  ]);

  /**
   * Validates required and recommended environment variables for PRINTOS
   */
  public static validate(env: Record<string, string | undefined> = process.env): EnvValidationResult {
    const isProduction = env.NODE_ENV === 'production';
    const missing: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    // 1. Core Supabase persistence requirements
    if (!env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL.includes('your-supabase-project')) {
      if (isProduction) {
        missing.push('NEXT_PUBLIC_SUPABASE_URL');
        errors.push('NEXT_PUBLIC_SUPABASE_URL is required for production database and private document storage.');
      } else {
        warnings.push('NEXT_PUBLIC_SUPABASE_URL not configured; falling back to in-memory repository.');
      }
    }

    if (!env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY.includes('your-service-role-key')) {
      if (isProduction) {
        missing.push('SUPABASE_SERVICE_ROLE_KEY');
        errors.push('SUPABASE_SERVICE_ROLE_KEY is required for production atomic stored procedures and RPC operations.');
      } else {
        warnings.push('SUPABASE_SERVICE_ROLE_KEY not configured.');
      }
    }

    // 2. Agent key security
    if (!env.PRINTOS_AGENT_KEY || this.INSECURE_DEFAULTS.has(env.PRINTOS_AGENT_KEY)) {
      if (isProduction) {
        missing.push('PRINTOS_AGENT_KEY');
        errors.push('PRINTOS_AGENT_KEY must be configured with a secure unique secret (min 16 chars) in production.');
      } else if (!env.PRINTOS_AGENT_KEY) {
        warnings.push('PRINTOS_AGENT_KEY is not set; agent endpoints will use default test secret.');
      }
    } else if (isProduction && env.PRINTOS_AGENT_KEY.length < 16) {
      errors.push('PRINTOS_AGENT_KEY is too short (must be at least 16 characters for production security).');
    }

    // 3. Admin Authentication & Session Secrets
    const adminSecret = env.ADMIN_JWT_SECRET;
    if (isProduction) {
      if (!adminSecret || this.INSECURE_DEFAULTS.has(adminSecret)) {
        errors.push('ADMIN_JWT_SECRET must be explicitly set with a high-entropy secret in production.');
      } else if (adminSecret.length < 16) {
        errors.push('ADMIN_JWT_SECRET is too short (must be at least 16 characters for production).');
      }
    }

    // Check default local admin email
    const adminEmail = (env.ADMIN_EMAIL || '').toLowerCase();
    if (isProduction && (adminEmail === 'admin@printos.local' || !adminEmail)) {
      errors.push('CRITICAL: Default ADMIN_EMAIL "admin@printos.local" must not be used in production. Set a real admin email address.');
    }

    // Check default local admin credentials
    const adminPassword = env.ADMIN_PASSWORD;
    if (adminPassword === 'admin123' || !adminPassword) {
      if (isProduction) {
        errors.push('CRITICAL: Default admin password "admin123" is detected. You MUST set a secure ADMIN_PASSWORD in production.');
      } else {
        warnings.push('Default admin credentials active (admin@printos.local / admin123). Change before deploying to production.');
      }
    }

    // 4. Cron endpoint security
    if (!env.CRON_SECRET || this.INSECURE_DEFAULTS.has(env.CRON_SECRET)) {
      if (isProduction) {
        errors.push('CRITICAL: CRON_SECRET must be set to a secure unique token in production to protect maintenance tasks.');
      } else {
        warnings.push('CRON_SECRET is not set; cron endpoints (/api/cron/*) will be accessible without authentication.');
      }
    }

    // 5. Payment provider checks. A mock gateway must never be reachable in production.
    const paymentProvider = (env.PAYMENT_PROVIDER || '').toLowerCase();
    if (isProduction && paymentProvider !== 'razorpay') {
      errors.push('PAYMENT_PROVIDER must be set to "razorpay" in production; mock payments are development-only.');
    }
    if (paymentProvider === 'razorpay' || env.RAZORPAY_KEY_ID) {
      if (!env.RAZORPAY_KEY_ID) missing.push('RAZORPAY_KEY_ID');
      if (!env.RAZORPAY_KEY_SECRET) missing.push('RAZORPAY_KEY_SECRET');
      if (!env.RAZORPAY_WEBHOOK_SECRET) {
        if (isProduction) {
          missing.push('RAZORPAY_WEBHOOK_SECRET');
          errors.push('RAZORPAY_WEBHOOK_SECRET is required to authenticate payment webhooks in production.');
        } else {
          warnings.push('RAZORPAY_WEBHOOK_SECRET is not configured; webhook signatures cannot be verified.');
        }
      }
    }

    // 6. WhatsApp provider checks. Webhooks must have a configured HMAC secret.
    const waProvider = (env.WHATSAPP_PROVIDER || '').toLowerCase();
    if (isProduction && !['openwa', 'meta'].includes(waProvider)) {
      errors.push('WHATSAPP_PROVIDER must be explicitly set to "openwa" or "meta" in production.');
    }
    if (waProvider === 'openwa' || env.OPENWA_BASE_URL || env.OPENWA_API_URL) {
      if (!env.OPENWA_BASE_URL && !env.OPENWA_API_URL) missing.push('OPENWA_BASE_URL');
      if (isProduction && !env.OPENWA_WEBHOOK_SECRET) {
        missing.push('OPENWA_WEBHOOK_SECRET');
        errors.push('OPENWA_WEBHOOK_SECRET is required to authenticate WhatsApp webhooks in production.');
      }
    }
    if (waProvider === 'meta' && isProduction && !env.WHATSAPP_APP_SECRET) {
      missing.push('WHATSAPP_APP_SECRET');
      errors.push('WHATSAPP_APP_SECRET is required to authenticate Meta WhatsApp webhooks in production.');
    }

    return {
      isValid: missing.length === 0 && errors.length === 0,
      missing,
      warnings,
      errors,
    };
  }

  /**
   * Asserts environment integrity in production and throws immediately on misconfiguration
   */
  public static assertProductionEnv(env: Record<string, string | undefined> = process.env): void {
    if (env.NODE_ENV !== 'production') {
      return;
    }

    const result = this.validate(env);
    if (!result.isValid) {
      const errorDetails = result.errors.join('\n  • ');
      throw new Error(
        `[CRITICAL PRODUCTION CONFIGURATION ERROR]: Missing required environment variables:\n  • ${errorDetails}`
      );
    }
  }
}
