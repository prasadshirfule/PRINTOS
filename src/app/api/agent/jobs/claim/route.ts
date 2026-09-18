import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get('x-agent-key') || req.headers.get('authorization')?.replace('Bearer ', '');
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing agent authentication token' }, { status: 401 });
    }

    const repo = getRepository();
    const agent = await repo.authenticateAgent(apiKey);
    if (!agent) {
      return NextResponse.json({ error: 'Invalid agent token' }, { status: 403 });
    }

    let printerId: string | undefined;
    try {
      const body = await req.json();
      printerId = body?.printerId;
    } catch {
      // Empty body is acceptable
    }

    // Atomic claim through repository scoped to the agent's shop
    const claimedJob = await repo.claimNextPrintJob(agent.id, printerId, agent.shopId || undefined);

    return NextResponse.json({
      ok: true,
      job: claimedJob,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to claim job' },
      { status: 500 }
    );
  }
}