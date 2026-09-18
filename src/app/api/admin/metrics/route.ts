import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';
import { verifyAdminAuth } from '@/lib/auth/admin-auth';

export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
  }

  const repo = getRepository();
  const shopId = auth.user.shopId;

  const [metrics, orders, jobs, printers, shop] = await Promise.all([
    repo.getDashboardMetrics(shopId),
    repo.listOrders({ limit: 50, shopId }),
    repo.listJobs({ limit: 50, shopId }),
    repo.listPrinters({ shopId }),
    repo.getShop(shopId),
  ]);

  return NextResponse.json({
    shop: shop || { id: shopId, name: 'PRINTOS Shop', slug: 'shop' },
    metrics,
    orders,
    jobs,
    printers,
  });
}