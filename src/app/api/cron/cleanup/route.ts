import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';
import { CleanupService } from '@/lib/storage/cleanup-service';
import { createLogger } from '@/lib/observability/logger';

export const dynamic = 'force-dynamic';

const logger = createLogger('CronCleanup');

export async function GET(req: NextRequest) {
  return handleCleanupCron(req);
}

export async function POST(req: NextRequest) {
  return handleCleanupCron(req);
}

async function handleCleanupCron(req: NextRequest) {
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

    const url = new URL(req.url);
    const retentionHoursParam = url.searchParams.get('retentionHours');
    const retentionHours = retentionHoursParam ? Number(retentionHoursParam) : 24;

    const repo = getRepository();
    const result = await CleanupService.runRetentionCleanup(repo, retentionHours);

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      retentionHours,
      result,
    });
  } catch (err: unknown) {
    logger.error('Retention cleanup cycle failed', err instanceof Error ? err : undefined);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'Retention cleanup cycle failed',
      },
      { status: 500 }
    );
  }
}
