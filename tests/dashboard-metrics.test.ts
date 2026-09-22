import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryPrintOSRepository } from '@/lib/repository/in-memory-repository';
import { PrintOrder, DEFAULT_SHOP_ID } from '@/types/printos';
import { isSameDayInTimezone, getTodayTimeRangeUtc, DEFAULT_SHOP_TIMEZONE } from '@/lib/utils/timezone-utils';

describe('Admin Dashboard "Today" Metrics & Timezone Scoping', () => {
  let repo: InMemoryPrintOSRepository;
  const SHOP_A = DEFAULT_SHOP_ID;
  const SHOP_B = '00000000-0000-0000-0000-000000000002';

  const createSampleOrder = (overrides: Partial<PrintOrder> = {}): PrintOrder => ({
    id: overrides.id || `ord_${Math.random().toString(36).substring(2, 9)}`,
    shopId: overrides.shopId || SHOP_A,
    orderNumber: overrides.orderNumber || `P${Math.floor(1000 + Math.random() * 9000)}`,
    customerPhone: overrides.customerPhone || '919876543210',
    customerName: overrides.customerName || 'Test Customer',
    status: overrides.status || 'COMPLETED',
    originalFilename: overrides.originalFilename || 'document.pdf',
    storagePath: overrides.storagePath || 'orders/document.pdf',
    fileType: overrides.fileType || 'pdf',
    fileSize: overrides.fileSize || 10240,
    pageCount: overrides.pageCount || 10,
    paperSize: overrides.paperSize || 'A4',
    colorMode: overrides.colorMode || 'BW',
    printSides: overrides.printSides || 'ONE_SIDED',
    copies: overrides.copies ?? 2,
    selectedPageCount: overrides.selectedPageCount ?? 5,
    subtotalPaisa: overrides.subtotalPaisa || 2000,
    discountPaisa: overrides.discountPaisa || 0,
    totalAmountPaisa: overrides.totalAmountPaisa ?? 2000,
    currency: overrides.currency || 'INR',
    paymentStatus: overrides.paymentStatus || 'PAID',
    createdAt: overrides.createdAt || new Date().toISOString(),
    completedAt: overrides.completedAt,
    failedAt: overrides.failedAt,
  });

  beforeEach(() => {
    repo = new InMemoryPrintOSRepository();
  });

  it('excludes yesterday orders from todayOrders count', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const today = new Date().toISOString();

    // 1 order yesterday
    await repo.createOrder(
      createSampleOrder({
        id: 'ord_yesterday_1',
        createdAt: yesterday,
        status: 'COMPLETED',
        completedAt: yesterday,
      })
    );

    // 1 order today
    await repo.createOrder(
      createSampleOrder({
        id: 'ord_today_1',
        createdAt: today,
        status: 'COMPLETED',
        completedAt: today,
      })
    );

    const metrics = await repo.getDashboardMetrics(SHOP_A);
    expect(metrics.todayOrders).toBe(1);
  });

  it('includes today completed order in completed count and contributes to revenue', async () => {
    const today = new Date().toISOString();

    await repo.createOrder(
      createSampleOrder({
        id: 'ord_completed_today',
        createdAt: today,
        status: 'COMPLETED',
        completedAt: today,
        totalAmountPaisa: 3500,
        copies: 3,
        selectedPageCount: 4,
      })
    );

    const metrics = await repo.getDashboardMetrics(SHOP_A);
    expect(metrics.completed).toBe(1);
    expect(metrics.revenuePaisa).toBe(3500);
    expect(metrics.pagesPrinted).toBe(12); // 3 copies * 4 pages
  });

  it('excludes today failed orders from revenue while counting in failed metric', async () => {
    const today = new Date().toISOString();

    // 1 failed order today
    await repo.createOrder(
      createSampleOrder({
        id: 'ord_failed_today',
        createdAt: today,
        status: 'FAILED',
        failedAt: today,
        totalAmountPaisa: 5000,
      })
    );

    // 1 completed order today
    await repo.createOrder(
      createSampleOrder({
        id: 'ord_completed_today_2',
        createdAt: today,
        status: 'COMPLETED',
        completedAt: today,
        totalAmountPaisa: 1500,
      })
    );

    const metrics = await repo.getDashboardMetrics(SHOP_A);
    expect(metrics.todayOrders).toBe(2);
    expect(metrics.failed).toBe(1);
    expect(metrics.completed).toBe(1);
    expect(metrics.revenuePaisa).toBe(1500); // Only completed order contributes to revenue
  });

  it('excludes queued, printing, awaiting_payment, cancelled from revenue', async () => {
    const today = new Date().toISOString();

    await repo.createOrder(
      createSampleOrder({
        id: 'ord_queued_1',
        createdAt: today,
        status: 'QUEUED',
        totalAmountPaisa: 4000,
      })
    );
    await repo.createOrder(
      createSampleOrder({
        id: 'ord_printing_1',
        createdAt: today,
        status: 'PRINTING',
        totalAmountPaisa: 6000,
      })
    );
    await repo.createOrder(
      createSampleOrder({
        id: 'ord_awaiting_1',
        createdAt: today,
        status: 'AWAITING_PAYMENT',
        totalAmountPaisa: 8000,
      })
    );
    await repo.createOrder(
      createSampleOrder({
        id: 'ord_cancelled_1',
        createdAt: today,
        status: 'CANCELLED',
        totalAmountPaisa: 9000,
      })
    );

    const metrics = await repo.getDashboardMetrics(SHOP_A);
    expect(metrics.queued).toBe(1);
    expect(metrics.printing).toBe(1);
    expect(metrics.completed).toBe(0);
    expect(metrics.revenuePaisa).toBe(0);
  });

  it('preserves strict multi-shop isolation in all dashboard metrics', async () => {
    const today = new Date().toISOString();

    // Shop A order
    await repo.createOrder(
      createSampleOrder({
        id: 'ord_shop_a',
        shopId: SHOP_A,
        createdAt: today,
        status: 'COMPLETED',
        completedAt: today,
        totalAmountPaisa: 2500,
      })
    );

    // Shop B order
    await repo.createOrder(
      createSampleOrder({
        id: 'ord_shop_b',
        shopId: SHOP_B,
        createdAt: today,
        status: 'COMPLETED',
        completedAt: today,
        totalAmountPaisa: 9900,
      })
    );

    const metricsA = await repo.getDashboardMetrics(SHOP_A);
    expect(metricsA.todayOrders).toBe(1);
    expect(metricsA.revenuePaisa).toBe(2500);

    const metricsB = await repo.getDashboardMetrics(SHOP_B);
    expect(metricsB.todayOrders).toBe(1);
    expect(metricsB.revenuePaisa).toBe(9900);
  });

  it('filters listOrders with todayOnly=true to exclude yesterday orders', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const today = new Date().toISOString();

    await repo.createOrder(
      createSampleOrder({
        id: 'ord_old',
        createdAt: yesterday,
      })
    );
    await repo.createOrder(
      createSampleOrder({
        id: 'ord_new',
        createdAt: today,
      })
    );

    const allOrders = await repo.listOrders({ shopId: SHOP_A });
    expect(allOrders.length).toBe(2);

    const todayOrders = await repo.listOrders({ shopId: SHOP_A, todayOnly: true });
    expect(todayOrders.length).toBe(1);
    expect(todayOrders[0].id).toBe('ord_new');
  });

  it('correctly handles timezone boundaries around UTC midnight for Asia/Kolkata', () => {
    // 2026-09-22 01:00:00 IST is 2026-09-21 19:30:00 UTC
    const istMidnightUtc = '2026-09-21T19:30:00.000Z';
    const referenceDate = new Date('2026-09-22T10:00:00.000Z'); // 15:30 IST on Sep 22

    const isToday = isSameDayInTimezone(istMidnightUtc, referenceDate, 'Asia/Kolkata');
    expect(isToday).toBe(true);

    const { startIso, endIso } = getTodayTimeRangeUtc('Asia/Kolkata', referenceDate);
    expect(startIso).toBe('2026-09-21T18:30:00.000Z');
    expect(endIso).toBe('2026-09-22T18:30:00.000Z');
  });

  it('handles completion-time semantics for orders created before midnight and completed today', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const today = new Date().toISOString();

    // Order created yesterday, but completed today
    await repo.createOrder(
      createSampleOrder({
        id: 'ord_cross_midnight',
        createdAt: yesterday,
        status: 'COMPLETED',
        completedAt: today,
        totalAmountPaisa: 4500,
        copies: 2,
        selectedPageCount: 10,
      })
    );

    const metrics = await repo.getDashboardMetrics(SHOP_A);
    // Was NOT created today -> todayOrders should be 0
    expect(metrics.todayOrders).toBe(0);
    // WAS completed today -> completed & revenue & pagesPrinted should count
    expect(metrics.completed).toBe(1);
    expect(metrics.revenuePaisa).toBe(4500);
    expect(metrics.pagesPrinted).toBe(20);
  });
});
