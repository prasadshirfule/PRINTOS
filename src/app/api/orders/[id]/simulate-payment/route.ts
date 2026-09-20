import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';
import { verifyAdminAuth } from '@/lib/auth/admin-auth';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const auth = await verifyAdminAuth(req);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const orderId = params.id;
    let transactionId = `txn_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let provider = 'MOCK_UPI';
    let amountPaisa: number | undefined;

    try {
      const body = await req.json();
      if (body.transactionId) transactionId = body.transactionId;
      if (body.provider) provider = body.provider;
      if (body.amountPaisa !== undefined) amountPaisa = Number(body.amountPaisa);
    } catch {
      // Body is optional
    }

    const repo = getRepository();
    const order = await repo.getOrder(orderId);
    if (!order || order.shopId !== auth.user.shopId) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }
    if (!Number.isInteger(amountPaisa) || amountPaisa !== order.totalAmountPaisa) {
      return NextResponse.json({ error: 'amountPaisa must exactly match the order total.' }, { status: 400 });
    }
    const result = await repo.simulateVerifiedPayment(orderId, transactionId, provider, amountPaisa);

    return NextResponse.json({
      ok: true,
      order: result.order,
      job: result.job,
      isDuplicate: result.isDuplicate,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Payment simulation failed' },
      { status: 400 }
    );
  }
}
