import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const ADMIN_COOKIE_NAME = 'printos_admin_session';

export interface AdminUser {
  id: string;
  email: string;
  role: 'admin' | 'staff';
}

export interface AdminAuthResult {
  authorized: boolean;
  user?: AdminUser;
  error?: string;
}

function getAuthSecret(): string {
  return process.env.ADMIN_JWT_SECRET || process.env.PRINTOS_AGENT_KEY || 'printos_default_secure_auth_key_123';
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Creates a signed tamper-proof session token for admin authentication using Web Crypto HMAC
 */
export async function createAdminToken(user: AdminUser, expiresInSeconds = 86400): Promise<string> {
  const enc = new TextEncoder();
  const payload = {
    ...user,
    exp: Date.now() + expiresInSeconds * 1000,
  };
  const payloadBase64 = toBase64Url(enc.encode(JSON.stringify(payload)));
  const secretKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(getAuthSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', secretKey, enc.encode(payloadBase64));
  const signature = toBase64Url(new Uint8Array(signatureBuffer));

  return `${payloadBase64}.${signature}`;
}

/**
 * Validates a signed admin session token using Web Crypto HMAC verification
 */
export async function verifyAdminToken(
  token: string
): Promise<{ valid: boolean; user?: AdminUser; error?: string }> {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) {
      return { valid: false, error: 'Malformed session token format' };
    }

    const [payloadBase64, receivedSig] = parts;
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const secretKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(getAuthSecret()),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigBytes = fromBase64Url(receivedSig);
    const isValid = await crypto.subtle.verify(
      'HMAC',
      secretKey,
      sigBytes as unknown as BufferSource,
      enc.encode(payloadBase64)
    );

    if (!isValid) {
      return { valid: false, error: 'Invalid token signature' };
    }

    const payloadJson = dec.decode(fromBase64Url(payloadBase64));
    const payload = JSON.parse(payloadJson);

    if (payload.exp && Date.now() > payload.exp) {
      return { valid: false, error: 'Admin session expired' };
    }

    return {
      valid: true,
      user: {
        id: payload.id,
        email: payload.email,
        role: payload.role || 'admin',
      },
    };
  } catch (err: unknown) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Failed to verify session token',
    };
  }
}

/**
 * Authenticates admin login credentials against Supabase Auth or configured admin credentials
 */
export async function authenticateAdminLogin(
  email: string,
  password: string
): Promise<{ success: boolean; token?: string; user?: AdminUser; error?: string }> {
  const normalizedEmail = email.trim().toLowerCase();

  // 1. Try Supabase Auth if credentials are configured
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const hasSupabase =
    Boolean(supabaseUrl && anonKey) &&
    !supabaseUrl?.includes('your-supabase-project');

  if (hasSupabase) {
    try {
      const supabase = createClient(supabaseUrl!, anonKey!, {
        auth: { persistSession: false },
      });

      const { data, error } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });

      if (!error && data.user) {
        const user: AdminUser = {
          id: data.user.id,
          email: data.user.email || normalizedEmail,
          role: 'admin',
        };
        const token = await createAdminToken(user);
        return { success: true, token, user };
      }
    } catch {
      // Fall through to local credentials
    }
  }

  // 2. Check local environment credentials (default / shop admin)
  const defaultEmail = (process.env.ADMIN_EMAIL || 'admin@printos.local').toLowerCase();
  const defaultPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if (normalizedEmail === defaultEmail && password === defaultPassword) {
    const user: AdminUser = {
      id: 'local-admin-01',
      email: defaultEmail,
      role: 'admin',
    };
    const token = await createAdminToken(user);
    return { success: true, token, user };
  }

  return {
    success: false,
    error: 'Invalid email or password. Please check your credentials.',
  };
}

/**
 * Server-side admin authentication validator for requests
 */
export async function verifyAdminAuth(req: NextRequest): Promise<AdminAuthResult> {
  const authHeader = req.headers.get('authorization');
  const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');
  const cookieToken = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
  const token = bearerToken || cookieToken;

  if (!token) {
    // Development bypass if dev key provided
    const devKey = req.headers.get('x-admin-key');
    if (devKey === 'dev-admin-secret') {
      return {
        authorized: true,
        user: { id: 'dev-admin', email: 'admin@printos.local', role: 'admin' },
      };
    }

    return {
      authorized: false,
      error: 'Missing admin session token. Please log in.',
    };
  }

  const result = await verifyAdminToken(token);
  if (!result.valid || !result.user) {
    return {
      authorized: false,
      error: result.error || 'Invalid or expired admin session.',
    };
  }

  return {
    authorized: true,
    user: result.user,
  };
}