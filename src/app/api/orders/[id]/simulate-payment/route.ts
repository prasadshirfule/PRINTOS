import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const orderId = params.id;
    let transactionId = `txn_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let provider = 'MOCK_UPI';
    let amountPaisa: number | undefined;

    try {
      const body = await req.json();
      if (body.transactionId) transactionId = body.transactionId;
      if (body.provider) provider = body.provider;
      if (body.amountPaisa) amountPaisa = Number(body.amountPaisa);
    } catch {
      // Body is optional
    }

    const repo = getRepository();
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