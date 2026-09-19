import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';
import { WhatsAppWorkerEngine } from '@/lib/whatsapp/worker-engine';
import { createLogger } from '@/lib/observability/logger';

export const dynamic = 'force-dynamic';

const logger = createLogger('CronProcessQueues');

export async function GET(req: NextRequest) {
  return handleCron(req);
}

export async function POST(req: NextRequest) {
  return handleCron(req);
}

async function handleCron(req: NextRequest) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = req.headers.get('authorization');
      const customHeader = req.headers.get('x-cron-secret');
      const token = authHeader?.replace('Bearer ', '') || customHeader;

      if (token !== cronSecret) {
        return NextResponse.json({ error: 'Unauthorized cron trigger' }, { status: 401 });
      }
    }

    const repo = getRepository();
    const worker = new WhatsAppWorkerEngine(repo);
    const result = await worker.runCycle(10, 120);

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      result,
    });
  } catch (err: unknown) {
    logger.error('Cron worker cycle failed', err instanceof Error ? err : undefined);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'Cron worker cycle failed',
      },
      { status: 500 }
    );
  }
}
