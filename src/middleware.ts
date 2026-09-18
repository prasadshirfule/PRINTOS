import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_COOKIE_NAME, verifyAdminToken } from '@/lib/auth/admin-auth';

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1. Allow login route and public auth APIs
  if (pathname === '/admin/login' || pathname.startsWith('/api/admin/auth/')) {
    const token = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
    if (token && pathname === '/admin/login') {
      const { valid } = await verifyAdminToken(token);
      if (valid) {
        return NextResponse.redirect(new URL('/admin', req.url));
      }
    }
    return NextResponse.next();
  }

  // 2. Protect Admin Pages (/admin/*)
  if (pathname.startsWith('/admin')) {
    const token = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
    if (!token) {
      const loginUrl = new URL('/admin/login', req.url);
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }

    const { valid } = await verifyAdminToken(token);
    if (!valid) {
      const loginUrl = new URL('/admin/login', req.url);
      loginUrl.searchParams.set('redirect', pathname);
      const res = NextResponse.redirect(loginUrl);
      res.cookies.delete(ADMIN_COOKIE_NAME);
      return res;
    }

    return NextResponse.next();
  }

  // 3. Protect Admin API Routes (/api/admin/*)
  if (pathname.startsWith('/api/admin')) {
    const authHeader = req.headers.get('authorization');
    const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');
    const cookieToken = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
    const token = bearerToken || cookieToken;

    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized: Admin authentication token is required.' },
        { status: 401 }
      );
    }

    const { valid, error } = await verifyAdminToken(token);
    if (!valid) {
      return NextResponse.json(
        { error: `Unauthorized: ${error || 'Invalid admin session token.'}` },
        { status: 401 }
      );
    }

    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
