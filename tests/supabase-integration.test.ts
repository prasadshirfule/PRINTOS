import { describe, it, expect } from 'vitest';
import { SupabasePrintOSRepository } from '@/lib/repository/supabase-repository';
import { PrintOrder } from '@/types/printos';

describe('Supabase PostgreSQL Real Integration Test', () => {
  const isEnabled = process.env.SUPABASE_INTEGRATION_TEST === 'true';
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const hasValidCredentials =
    Boolean(supabaseUrl && serviceRoleKey) &&
    !supabaseUrl?.includes('your-supabase-project') &&
    !serviceRoleKey?.includes('your-service-role-key');

  it('verifies real Supabase database persistence, transactions, and RPC queue claiming', async () => {
    if (!isEnabled || !hasValidCredentials) {
      console.log(
        '\n====================================================================\n' +
        '⚠️  [SUPABASE INTEGRATION TEST SKIPPED]\n' +
        'Reason: SUPABASE_INTEGRATION_TEST=true is not set or Supabase credentials\n' +
        '(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) are missing.\n' +
        'Test was skipped cleanly without faking.\n' +
        'To run: cross-env SUPABASE_INTEGRATION_TEST=true NEXT_PUBLIC_SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> npm run test:integration\n' +
        '====================================================================\n'
      );
      expect(true).toBe(true);
      return;
    }

    const repo = new SupabasePrintOSRepository(supabaseUrl!, serviceRoleKey!);

    // 1. Create order in Supabase
    const orderId = crypto.randomUUID();
    const orderNumber = `P${Math.floor(10000 + Math.random() * 90000)}`;
    const order: PrintOrder = {
      id: orderId,
      orderNumber,
      customerPhone: '919800000001',
      customerName: 'Supabase Integration Test Customer',
      status: 'AWAITING_PAYMENT',
      originalFilename: 'db-test.pdf',
      storagePath: `orders/${orderId}/db-test.pdf`,
      fileType: 'pdf',
      fileSize: 2048,
      pageCount: 2,
      paperSize: 'A4',
      colorMode: 'BW',
      printSides: 'ONE_SIDED',
      copies: 1,
      selectedPageCount: 2,
      subtotalPaisa: 400,
      discountPaisa: 0,
      totalAmountPaisa: 400,
      currency: 'INR',
      paymentStatus: 'PENDING',
      createdAt: new Date().toISOString(),
    };

    const created = await repo.createOrder(order);
    expect(created.id).toBe(orderId);

    // 2. Simulate verified payment (creates payment_transactions row + moves order to PAID & QUEUED + creates exactly 1 print job)
    const txId = `pg_tx_${Date.now()}`;
    const paymentResult = await repo.simulateVerifiedPayment(orderId, txId, 'TEST_GATEWAY', 400);

    expect(paymentResult.isDuplicate).toBe(false);
    expect(paymentResult.order.status).toBe('QUEUED');
    expect(paymentResult.job.status).toBe('QUEUED');

    // 3. Test idempotency: duplicate webhook does not recreate job
    const dupResult = await repo.simulateVerifiedPayment(orderId, txId, 'TEST_GATEWAY', 400);
    expect(dupResult.isDuplicate).toBe(true);

    // 4. Print Agent claims job atomically via PostgreSQL RPC claim_next_print_job()
    const testAgentId = '00000000-0000-0000-0000-000000000002';
    const claimed = await repo.claimNextPrintJob(testAgentId);

    expect(claimed).not.toBeNull();
    expect(claimed?.jobId).toBe(paymentResult.job.id);

    // 5. Verify order transitioned to PRINTING in Supabase
    let refreshedOrder = await repo.getOrder(orderId);
    expect(refreshedOrder?.status).toBe('PRINTING');

    // 6. Agent updates status to COMPLETED
    await repo.updateJobStatus(claimed!.jobId, testAgentId, { status: 'COMPLETED' });

    refreshedOrder = await repo.getOrder(orderId);
    const refreshedJob = await repo.getJob(claimed!.jobId);

    expect(refreshedJob?.status).toBe('COMPLETED');
    expect(refreshedOrder?.status).toBe('COMPLETED');

    // 7. Verify audit events recorded in PostgreSQL
    const events = await repo.getOrderEvents(orderId);
    expect(events.length).toBeGreaterThanOrEqual(4);
  });
});