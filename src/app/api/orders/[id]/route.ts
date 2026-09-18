import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';
import { verifyAdminAuth } from '@/lib/auth/admin-auth';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await verifyAdminAuth(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
  }

  const repo = getRepository();
  const orderId = params.id;
  const order = await repo.getOrder(orderId);
  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  const [events, job] = await Promise.all([
    repo.getOrderEvents(orderId),
    repo.getJobByOrderId(orderId),
  ]);

  return NextResponse.json({
    order,
    job,
    events,
  });
}