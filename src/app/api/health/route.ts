import { NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';
import { DEFAULT_SHOP_ID } from '@/types/printos';

export const dynamic = 'force-dynamic';

export async function GET() {
  const startTime = Date.now();
  const checks: Record<string, { status: 'healthy' | 'degraded' | 'unhealthy'; latencyMs?: number; message?: string }> = {};

  // 1. Check Repository connectivity & responsiveness
  try {
    const repoStart = Date.now();
    const repo = getRepository();
    await repo.getShop(DEFAULT_SHOP_ID);
    checks.repository = {
      status: 'healthy',
      latencyMs: Date.now() - repoStart,
    };
  } catch (err: unknown) {
    checks.repository = {
      status: 'degraded',
      message: err instanceof Error ? err.message : 'Repository check failed',
    };
  }

  // 2. Memory / System stats
  const memory = process.memoryUsage();
  const memUsageMb = {
    rss: Math.round(memory.rss / (1024 * 1024)),
    heapTotal: Math.round(memory.heapTotal / (1024 * 1024)),
    heapUsed: Math.round(memory.heapUsed / (1024 * 1024)),
  };

  const isHealthy = Object.values(checks).every((c) => c.status === 'healthy');
  const httpStatus = isHealthy ? 200 : 503;

  return NextResponse.json(
    {
      status: isHealthy ? 'healthy' : 'degraded',
      service: 'printos',
      version: '0.1.0',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      responseTimeMs: Date.now() - startTime,
      checks,
      system: {
        memory: memUsageMb,
        nodeVersion: process.version,
      },
    },
    { status: httpStatus }
  );
}
