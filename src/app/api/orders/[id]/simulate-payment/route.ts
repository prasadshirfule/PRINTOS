import { NextRequest, NextResponse } from 'next/server';
import { globalStore } from '@/lib/db/store';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const orderId = params.id;
    let transactionId = `txn_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let provider = 'MOCK_UPI';

    try {
      const body = await req.json();
      if (body.transactionId) transactionId = body.transactionId;
      if (body.provider) provider = body.provider;
    } catch {
      // Body is optional
    }

    const result = globalStore.simulateVerifiedPayment(orderId, transactionId, provider);

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
