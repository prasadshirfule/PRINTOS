import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getRepository } from '@/lib/repository';
import { CleanupService } from '@/lib/storage/cleanup-service';
import { GET, POST } from '@/app/api/cron/cleanup/route';
import { PrintOrder } from '@/types/printos';

describe('File Retention & Storage Cleanup Service', () => {
  const repo = getRepository();
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(async () => {
    if (repo.clear) {
      await repo.clear();
    }
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalCronSecret;
  });

  const createOrderWithAge = async (
    id: string,
    orderNumber: string,
    status: any,
    ageHours: number,
    storagePath = `orders/${id}/doc.pdf`
  ): Promise<PrintOrder> => {
    const createdAt = new Date(Date.now() - ageHours * 3600 * 1000).toISOString();
    const order: PrintOrder = {
      id,
      orderNumber,
      customerPhone: '+919876543210',
      status,
      originalFilename: 'doc.pdf',
      storagePath,
      fileType: 'pdf',
      fileSize: 2048,
      pageCount: 5,
      paperSize: 'A4',
      colorMode: 'BW',
      printSides: 'ONE_SIDED',
      copies: 1,
      selectedPageCount: 5,
      subtotalPaisa: 1000,
      discountPaisa: 0,
      totalAmountPaisa: 1000,
      currency: 'INR',
      paymentStatus: 'PAID',
      createdAt,
    };
    return repo.createOrder(order);
  };

  it('purges files for completed, failed, cancelled, and expired orders older than retention period', async () => {
    // 48 hours old COMPLETED order -> should be purged
    await createOrderWithAge('ord_old_comp', 'P1001', 'COMPLETED', 48);

    // 30 hours old CANCELLED order -> should be purged
    await createOrderWithAge('ord_old_canc', 'P1002', 'CANCELLED', 30);

    // 5 hours old COMPLETED order -> should NOT be purged (retention: 24h)
    await createOrderWithAge('ord_recent_comp', 'P1003', 'COMPLETED', 5);

    // 48 hours old active QUEUED order -> should NOT be purged
    await createOrderWithAge('ord_old_queued', 'P1004', 'QUEUED', 48);

    const result = await CleanupService.runRetentionCleanup(repo, 24);

    expect(result.processedOrdersCount).toBe(2);
    expect(result.purgedFilesCount).toBe(2);
    expect(result.errors.length).toBe(0);

    // Check audit events recorded
    const events = await repo.getOrderEvents('ord_old_comp');
    const purgeEvent = events.find((e) => e.eventType === 'DOCUMENT_PURGED');
    expect(purgeEvent).toBeDefined();
  });

  it('enforces CRON_SECRET authentication on the cleanup endpoint', async () => {
    process.env.CRON_SECRET = 'super_secret_cron_token_123';

    // Request without token -> 401
    const req1 = new NextRequest('http://localhost:3000/api/cron/cleanup?retentionHours=24');
    const res1 = await GET(req1);
    expect(res1.status).toBe(401);

    // Request with invalid token -> 401
    const req2 = new NextRequest('http://localhost:3000/api/cron/cleanup?retentionHours=24', {
      headers: { authorization: 'Bearer wrong_token' },
    });
    const res2 = await GET(req2);
    expect(res2.status).toBe(401);

    // Request with valid authorization token -> 200
    const req3 = new NextRequest('http://localhost:3000/api/cron/cleanup?retentionHours=24', {
      headers: { authorization: 'Bearer super_secret_cron_token_123' },
    });
    const res3 = await GET(req3);
    expect(res3.status).toBe(200);
    const data3 = await res3.json();
    expect(data3.success).toBe(true);
  });
});
