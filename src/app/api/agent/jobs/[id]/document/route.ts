import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
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

    const jobId = params.id;
    const job = await repo.getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: 'Print job not found' }, { status: 404 });
    }

    // Strict Authorization: Agent must own this claimed job
    if (job.agentId !== agent.id) {
      return NextResponse.json(
        { error: 'Access denied: Document can only be accessed by the agent that claimed this job.' },
        { status: 403 }
      );
    }

    if (job.status !== 'CLAIMED' && job.status !== 'PRINTING') {
      return NextResponse.json(
        { error: `Document download not allowed for job in "${job.status}" state.` },
        { status: 400 }
      );
    }

    // Return mock document content or presigned signed URL redirect
    return new NextResponse('MOCK SECURE PRINT DOCUMENT BUFFER', {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="job-${jobId}.pdf"`,
      },
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to retrieve document' },
      { status: 500 }
    );
  }
}