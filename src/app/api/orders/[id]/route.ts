import { NextRequest, NextResponse } from 'next/server';
import { globalStore } from '@/lib/db/store';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const orderId = params.id;
  const order = globalStore.getOrder(orderId);
  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  const events = globalStore.getOrderEvents(orderId);
  const job = globalStore.getJobByOrderId(orderId);

  return NextResponse.json({
    order,
    job,
    events,
  });
}
