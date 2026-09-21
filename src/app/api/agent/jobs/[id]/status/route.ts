import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getRepository, UnauthorizedAgentJobError } from '@/lib/repository';
import { AgentJobStatusUpdate } from '@/types/printos';
import { NotificationService } from '@/lib/whatsapp/notification-service';
import { WhatsAppWorkerEngine } from '@/lib/whatsapp/worker-engine';
import { createLogger } from '@/lib/observability/logger';

const logger = createLogger('AgentJobStatusRoute');

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
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
    const body = (await req.json()) as AgentJobStatusUpdate;

    if (!body.status || !['PRINTING', 'COMPLETED', 'FAILED'].includes(body.status)) {
      return NextResponse.json(
        { error: 'Invalid status. Expected PRINTING, COMPLETED, or FAILED' },
        { status: 400 }
      );
    }

    // Enforces agent ownership: only the claiming agent can update the job
    const updatedJob = await repo.updateJobStatus(jobId, agent.id, body);

    // Dispatch WhatsApp notification to customer via transactional outbox only for finalized/non-transient status
    if (updatedJob.status !== 'RETRY_PENDING') {
      const order = await repo.getOrder(updatedJob.orderId);
      if (order) {
        await NotificationService.notifyOrderStatus(repo, order, updatedJob.status as any, body.errorMessage);
      }

      // Eagerly drain outbox so notifications are delivered immediately without waiting for cron
      if (process.env.DISABLE_EAGER_WORKER !== 'true') {
        try {
          const worker = new WhatsAppWorkerEngine(repo);
          waitUntil(
            worker.runCycle().catch((e) => {
              logger.warn('Background worker cycle failed, deferring to cron', {
                errorMessage: e instanceof Error ? e.message : String(e),
              });
            })
          );
        } catch (workerErr) {
          logger.warn('Failed to start eager worker cycle, deferring to cron', {
            errorMessage: workerErr instanceof Error ? workerErr.message : String(workerErr),
          });
        }
      }
    }

    return NextResponse.json({
      ok: true,
      job: updatedJob,
    });
  } catch (err: unknown) {
    if (err instanceof UnauthorizedAgentJobError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update job status' },
      { status: 500 }
    );
  }
}