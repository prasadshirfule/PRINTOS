export interface EnvValidationResult {
  isValid: boolean;
  missing: string[];
  warnings: string[];
  errors: string[];
}

export class ProductionEnvValidator {
  /**
   * Validates required and recommended environment variables for PRINTOS
   */
  public static validate(env: Record<string, string | undefined> = process.env): EnvValidationResult {
    const isProduction = env.NODE_ENV === 'production';
    const missing: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    // Core Supabase persistence requirements
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

    // Agent key security
    if (!env.PRINTOS_AGENT_KEY || env.PRINTOS_AGENT_KEY === 'mock-agent-secret-token') {
      if (isProduction) {
        missing.push('PRINTOS_AGENT_KEY');
        errors.push('PRINTOS_AGENT_KEY must be a secure unique secret in production, not the default mock token.');
      }
    }

    // Cron endpoint security
    if (!env.CRON_SECRET) {
      if (isProduction) {
        warnings.push('CRON_SECRET is not set; cron endpoints (/api/cron/*) will be accessible without authentication.');
      }
    }

    // Razorpay payment provider checks
    const paymentProvider = (env.PAYMENT_PROVIDER || '').toLowerCase();
    if (paymentProvider === 'razorpay' || env.RAZORPAY_KEY_ID) {
      if (!env.RAZORPAY_KEY_ID) missing.push('RAZORPAY_KEY_ID');
      if (!env.RAZORPAY_KEY_SECRET) missing.push('RAZORPAY_KEY_SECRET');
      if (!env.RAZORPAY_WEBHOOK_SECRET) warnings.push('RAZORPAY_WEBHOOK_SECRET is recommended for verifying payment signatures.');
    }

    // OpenWA provider checks
    const waProvider = (env.WHATSAPP_PROVIDER || '').toLowerCase();
    if (waProvider === 'openwa' || env.OPENWA_API_URL) {
      if (!env.OPENWA_API_URL) missing.push('OPENWA_API_URL');
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
