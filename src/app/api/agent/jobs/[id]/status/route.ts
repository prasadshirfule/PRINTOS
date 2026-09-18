import { NextRequest, NextResponse } from 'next/server';
import { globalStore } from '@/lib/db/store';
import { AgentJobStatusUpdate } from '@/types/printos';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const apiKey = req.headers.get('x-agent-key') || req.headers.get('authorization')?.replace('Bearer ', '');
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing agent authentication token' }, { status: 401 });
    }

    const agent = globalStore.authenticateAgent(apiKey);
    if (!agent) {
      return NextResponse.json({ error: 'Invalid agent token' }, { status: 403 });
    }

    const jobId = params.id;
    const body = (await req.json()) as AgentJobStatusUpdate;

    if (!body.status || !['PRINTING', 'COMPLETED', 'FAILED'].includes(body.status)) {
      return NextResponse.json(
        { error: 'Invalid status. Expected PRINTING, COMPLETED, or FAILED' },
        { status: 400 }
      );
    }

    const updatedJob = globalStore.updateJobStatus(jobId, body);

    return NextResponse.json({
      ok: true,
      job: updatedJob,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update job status' },
      { status: 500 }
    );
  }
}
