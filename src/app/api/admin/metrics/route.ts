import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';
import { verifyAdminAuth } from '@/lib/auth/admin-auth';

export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
  }

  const repo = getRepository();
  const [metrics, orders, jobs, printers] = await Promise.all([
    repo.getDashboardMetrics(),
    repo.listOrders({ limit: 50 }),
    repo.listJobs({ limit: 50 }),
    repo.listPrinters(),
  ]);

  return NextResponse.json({
    metrics,
    orders,
    jobs,
    printers,
  });
}