import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  createAdminToken,
  verifyAdminToken,
  authenticateAdminLogin,
  ADMIN_COOKIE_NAME,
} from '@/lib/auth/admin-auth';
import { POST as loginHandler } from '@/app/api/admin/auth/login/route';
import { POST as logoutHandler } from '@/app/api/admin/auth/logout/route';
import { GET as meHandler } from '@/app/api/admin/auth/me/route';
import { DEFAULT_SHOP_ID } from '@/types/printos';

describe('Admin Authentication & Session Protection', () => {
  const originalAdminEmail = process.env.ADMIN_EMAIL;
  const originalAdminPass = process.env.ADMIN_PASSWORD;

  beforeEach(() => {
    process.env.ADMIN_EMAIL = 'admin@printos.local';
    process.env.ADMIN_PASSWORD = 'test_password_123';
  });

  afterEach(() => {
    process.env.ADMIN_EMAIL = originalAdminEmail;
    process.env.ADMIN_PASSWORD = originalAdminPass;
  });

  describe('Token Signing & Cryptographic Verification', () => {
    it('creates a signed token and verifies valid session payload', async () => {
      const user = { id: 'u1', email: 'staff@shop.com', role: 'admin' as const, shopId: DEFAULT_SHOP_ID };
      const token = await createAdminToken(user, 3600);

      expect(typeof token).toBe('string');
      expect(token).toContain('.');

      const result = await verifyAdminToken(token);
      expect(result.valid).toBe(true);
      expect(result.user?.email).toBe('staff@shop.com');
      expect(result.user?.role).toBe('admin');
      expect(result.user?.shopId).toBe(DEFAULT_SHOP_ID);
    });

    it('rejects tampered token signatures', async () => {
      const user = { id: 'u1', email: 'staff@shop.com', role: 'admin' as const, shopId: DEFAULT_SHOP_ID };
      const token = await createAdminToken(user, 3600);
      const [payload] = token.split('.');
      const tamperedToken = `${payload}.invalid_tampered_signature`;

      const result = await verifyAdminToken(tamperedToken);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid token signature');
    });

    it('rejects expired tokens', async () => {
      const user = { id: 'u1', email: 'staff@shop.com', role: 'admin' as const, shopId: DEFAULT_SHOP_ID };
      // Expired 10 seconds ago
      const expiredToken = await createAdminToken(user, -10);

      const result = await verifyAdminToken(expiredToken);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expired');
    });
  });

  describe('Credential Authentication', () => {
    it('authenticates valid admin credentials', async () => {
      const res = await authenticateAdminLogin('admin@printos.local', 'test_password_123');
      expect(res.success).toBe(true);
      expect(res.token).toBeDefined();
      expect(res.user?.email).toBe('admin@printos.local');
      expect(res.user?.shopId).toBe(DEFAULT_SHOP_ID);
    });

    it('rejects invalid password', async () => {
      const res = await authenticateAdminLogin('admin@printos.local', 'wrong_password');
      expect(res.success).toBe(false);
      expect(res.error).toContain('Invalid email or password');
    });

    it('rejects unconfigured user', async () => {
      const res = await authenticateAdminLogin('unknown@shop.com', 'test_password_123');
      expect(res.success).toBe(false);
    });
  });

  describe('Auth API Routes', () => {
    it('login route sets httpOnly session cookie on successful login', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@printos.local', password: 'test_password_123' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await loginHandler(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);

      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain(ADMIN_COOKIE_NAME);
      expect(setCookie).toContain('HttpOnly');
    });

    it('login route rejects invalid credentials with 401', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@printos.local', password: 'bad_password' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await loginHandler(req);
      expect(res.status).toBe(401);
    });

    it('logout route clears session cookie', async () => {
      const res = await logoutHandler();
      expect(res.status).toBe(200);

      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain(`${ADMIN_COOKIE_NAME}=;`);
    });

    it('me route returns user profile when authenticated via session cookie', async () => {
      const user = { id: 'u1', email: 'admin@printos.local', role: 'admin' as const, shopId: DEFAULT_SHOP_ID };
      const token = await createAdminToken(user, 3600);

      const req = new NextRequest('http://localhost:3000/api/admin/auth/me', {
        headers: { cookie: `${ADMIN_COOKIE_NAME}=${token}` },
      });

      const res = await meHandler(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.authenticated).toBe(true);
      expect(data.user.email).toBe('admin@printos.local');
      expect(data.user.shopId).toBe(DEFAULT_SHOP_ID);
    });
  });
});
