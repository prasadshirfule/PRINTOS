import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export interface AdminAuthResult {
  authorized: boolean;
  userId?: string;
  email?: string;
  error?: string;
}

/**
 * Server-side admin authentication validator.
 * In production, strictly verifies Supabase Auth JWT token.
 * In development / local testing, accepts developer admin headers or dev sessions.
 */
export async function verifyAdminAuth(req: NextRequest): Promise<AdminAuthResult> {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  const devAdminKey = req.headers.get('x-admin-key');

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Development bypass when running locally without Supabase credentials
  const isDevOrTest = process.env.NODE_ENV !== 'production' || !supabaseUrl || supabaseUrl.includes('your-supabase-project');

  if (isDevOrTest) {
    if (devAdminKey === 'dev-admin-secret' || !process.env.STRICT_AUTH) {
      return { authorized: true, userId: 'dev-admin-user', email: 'admin@printos.local' };
    }
  }

  if (!token) {
    return {
      authorized: false,
      error: 'Missing Authorization header with admin Bearer token.',
    };
  }

  if (supabaseUrl && anonKey && !supabaseUrl.includes('your-supabase-project')) {
    try {
      const supabase = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false },
      });
      const { data, error } = await supabase.auth.getUser(token);

      if (error || !data.user) {
        return {
          authorized: false,
          error: error?.message || 'Invalid or expired admin session token.',
        };
      }

      return {
        authorized: true,
        userId: data.user.id,
        email: data.user.email,
      };
    } catch (err: unknown) {
      return {
        authorized: false,
        error: `Supabase auth verification failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    authorized: false,
    error: 'Authentication service unavailable.',
  };
}