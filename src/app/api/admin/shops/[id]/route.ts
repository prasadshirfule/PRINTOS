import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';
import { verifyAdminAuth } from '@/lib/auth/admin-auth';
import { DEFAULT_SHOP_ID, Shop } from '@/types/printos';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const auth = await verifyAdminAuth(req);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
  }

  const { id: shopId } = params;
  const userShopId = auth.user.shopId;

  // Tenant isolation: staff from a single shop cannot inspect other shops
  if (userShopId && userShopId !== DEFAULT_SHOP_ID && userShopId !== shopId) {
    return NextResponse.json({ error: 'Access denied to this shop' }, { status: 403 });
  }

  const repo = getRepository();

  try {
    const shop = await repo.getShop(shopId);
    if (!shop) {
      return NextResponse.json({ error: 'Shop not found' }, { status: 404 });
    }

    const [orders, printers, metrics] = await Promise.all([
      repo.listOrders({ shopId, limit: 50 }),
      repo.listPrinters({ shopId }),
      repo.getDashboardMetrics(shopId),
    ]);

    return NextResponse.json({
      shop,
      stats: {
        ordersCount: orders.length,
        printersCount: printers.length,
        onlinePrintersCount: printers.filter((p) => p.status === 'ONLINE').length,
        todayOrders: metrics.todayOrders,
        activeQueue: metrics.queued + metrics.printing,
        revenuePaisa: metrics.revenuePaisa,
        pagesPrinted: metrics.pagesPrinted,
      },
      printers,
      recentOrders: orders.slice(0, 10),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to get shop details';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const auth = await verifyAdminAuth(req);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
  }

  const { id: shopId } = params;
  const userShopId = auth.user.shopId;

  // Tenant isolation: staff can only update their own shop
  if (userShopId && userShopId !== DEFAULT_SHOP_ID && userShopId !== shopId) {
    return NextResponse.json({ error: 'Access denied to update this shop' }, { status: 403 });
  }

  const repo = getRepository();

  try {
    const body = await req.json();
    const updates: Partial<Shop> = {};

    if (body.name !== undefined) {
      if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        return NextResponse.json({ error: 'Shop name cannot be empty' }, { status: 400 });
      }
      updates.name = body.name.trim();
    }

    if (body.slug !== undefined) {
      updates.slug = body.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    }

    if (body.phone !== undefined) {
      updates.phone = body.phone ? String(body.phone).trim() : null;
    }

    if (body.address !== undefined) {
      updates.address = body.address ? String(body.address).trim() : null;
    }

    if (body.currency !== undefined) {
      updates.currency = String(body.currency).trim().toUpperCase();
    }

    if (body.isActive !== undefined) {
      updates.isActive = Boolean(body.isActive);
    }

    const updated = await repo.updateShop(shopId, updates);

    return NextResponse.json({
      shop: updated,
      message: 'Shop updated successfully',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to update shop';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
