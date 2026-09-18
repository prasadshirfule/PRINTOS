import { describe, it, expect } from 'vitest';
import { GET } from '@/app/api/health/route';

describe('Health Check API (/api/health)', () => {
  it('returns healthy status, system metrics, and repository check', async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('healthy');
    expect(data.service).toBe('printos');
    expect(data.version).toBe('0.1.0');
    expect(typeof data.uptimeSeconds).toBe('number');
    expect(data.checks.repository.status).toBe('healthy');
    expect(typeof data.checks.repository.latencyMs).toBe('number');
    expect(data.system.memory.heapUsed).toBeGreaterThan(0);
    expect(data.system.nodeVersion).toBeDefined();
  });
});
