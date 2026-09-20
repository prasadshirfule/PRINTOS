import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';
import { verifyAdminAuth } from '@/lib/auth/admin-auth';
import { Shop, DEFAULT_SHOP_ID } from '@/types/printos';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
  }
  const repo = getRepository();
  const userShopId = auth.user.shopId;

  try {
    const allShops = await repo.listShops();

    // If user belongs to a specific shop (and not the default flagship/super-admin shop), scope to their shop
    const shopsToReturn =
      userShopId && userShopId !== DEFAULT_SHOP_ID
        ? allShops.filter((s) => s.id === userShopId)
        : allShops;

    // Enhance each shop with live operational statistics
    const enrichedShops = await Promise.all(
      shopsToReturn.map(async (shop) => {
        const [orders, printers, metrics] = await Promise.all([
          repo.listOrders({ shopId: shop.id, limit: 100 }),
          repo.listPrinters({ shopId: shop.id }),
          repo.getDashboardMetrics(shop.id),
        ]);

        return {
          ...shop,
          stats: {
            ordersCount: orders.length,
            printersCount: printers.length,
            onlinePrintersCount: printers.filter((p) => p.status === 'ONLINE').length,
            todayOrders: metrics.todayOrders,
            activeQueue: metrics.queued + metrics.printing,
            revenuePaisa: metrics.revenuePaisa,
            pagesPrinted: metrics.pagesPrinted,
          },
        };
      })
    );

    return NextResponse.json({
      shops: enrichedShops,
      currentShopId: userShopId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to list shops';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verifyAdminAuth(req);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
  }
  if (auth.user.shopId !== DEFAULT_SHOP_ID) {
    return NextResponse.json({ error: 'Only the platform administrator can create shops.' }, { status: 403 });
  }

  const repo = getRepository();

  try {
    const body = await req.json();
    const { name, slug, phone, address, currency = 'INR', isActive = true } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Shop name is required' }, { status: 400 });
    }

    const generatedSlug =
      slug && typeof slug === 'string' && slug.trim()
        ? slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
        : name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const now = new Date().toISOString();
    const newShop: Shop = {
      id: body.id || randomUUID(),
      name: name.trim(),
      slug: generatedSlug,
      phone: phone?.trim() || null,
      address: address?.trim() || null,
      currency: currency || 'INR',
      isActive: Boolean(isActive),
      createdAt: now,
      updatedAt: now,
    };

    const created = await repo.createShop(newShop);

    return NextResponse.json(
      {
        shop: created,
        message: 'Shop created successfully',
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to create shop';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
