import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
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

  it('verifies real Supabase database persistence, transactions, RPC queue claiming, and private storage', async () => {
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
    const rawSupabase = createClient(supabaseUrl!, serviceRoleKey!, {
      auth: { persistSession: false },
    });

    // ------------------------------------------------------------------------
    // 1. Verify Storage Bucket Exists, is PRIVATE, and Signed URL works
    // ------------------------------------------------------------------------
    console.log('▶ [1/6] Verifying Supabase Storage Bucket & Signed Download URL...');
    const { data: buckets, error: bucketError } = await rawSupabase.storage.listBuckets();
    if (bucketError) {
      throw new Error(`Failed to list Supabase storage buckets: ${bucketError.message}`);
    }

    let docBucket = buckets.find((b) => b.name === 'print-documents');
    if (!docBucket) {
      // Create private bucket if not present
      const { data: createdBucket, error: createError } = await rawSupabase.storage.createBucket('print-documents', {
        public: false,
      });
      if (createError) {
        throw new Error(`Failed to create "print-documents" storage bucket: ${createError.message}`);
      }
      docBucket = { id: 'print-documents', name: 'print-documents', public: false } as any;
    }

    expect(docBucket.public).toBe(false); // MUST BE PRIVATE

    // Upload test document to private storage
    const testDocPath = `integration-tests/test-${Date.now()}.pdf`;
    const testDocContent = Buffer.from('REAL SUPABASE INTEGRATION TEST DOCUMENT CONTENT');
    const { error: uploadError } = await rawSupabase.storage
      .from('print-documents')
      .upload(testDocPath, testDocContent, { contentType: 'application/pdf', upsert: true });

    if (uploadError) {
      throw new Error(`Failed to upload test document to private bucket: ${uploadError.message}`);
    }

    // Generate short-lived signed URL (300 seconds)
    const { data: signedData, error: signError } = await rawSupabase.storage
      .from('print-documents')
      .createSignedUrl(testDocPath, 300);

    if (signError || !signedData?.signedUrl) {
      throw new Error(`Failed to generate signed download URL: ${signError?.message}`);
    }

    // Fetch from signed URL and verify HTTP 200 and exact content
    const fetchRes = await fetch(signedData.signedUrl);
    expect(fetchRes.status).toBe(200);
    const fetchedText = await fetchRes.text();
    expect(fetchedText).toBe('REAL SUPABASE INTEGRATION TEST DOCUMENT CONTENT');

    // Clean up test document
    await rawSupabase.storage.from('print-documents').remove([testDocPath]);
    console.log('  ✓ Private storage verified: public=false, signed URL active and tested.');

    // ------------------------------------------------------------------------
    // 2. Order Persistence in PostgreSQL
    // ------------------------------------------------------------------------
    console.log('▶ [2/6] Verifying Order Persistence in PostgreSQL...');
    const orderId = crypto.randomUUID();
    const orderNumber = `P${Math.floor(10000 + Math.random() * 90000)}`;
    const order: PrintOrder = {
      id: orderId,
      orderNumber,
      customerPhone: '919800000001',
      customerName: 'Real Supabase Customer',
      status: 'AWAITING_PAYMENT',
      originalFilename: 'real-document.pdf',
      storagePath: `orders/${orderId}/real-document.pdf`,
      fileType: 'pdf',
      fileSize: 4096,
      pageCount: 3,
      paperSize: 'A4',
      colorMode: 'BW',
      printSides: 'BOTH_SIDES',
      copies: 2,
      selectedPageCount: 3,
      subtotalPaisa: 1200, // 3 * 2 * 200 = 1200 paisa
      discountPaisa: 0,
      totalAmountPaisa: 1200,
      currency: 'INR',
      paymentStatus: 'PENDING',
      createdAt: new Date().toISOString(),
    };

    const created = await repo.createOrder(order);
    expect(created.id).toBe(orderId);
    expect(created.orderNumber).toBe(orderNumber);

    // Verify unique order_number constraint by attempting duplicate insertion
    const duplicateOrder = { ...order, id: crypto.randomUUID() };
    await expect(repo.createOrder(duplicateOrder)).rejects.toThrow();
    console.log('  ✓ Order persisted in PostgreSQL and unique order_number constraint verified.');

    // ------------------------------------------------------------------------
    // 3. Payment Transactions Insertion & Idempotency
    // ------------------------------------------------------------------------
    console.log('▶ [3/6] Verifying Payment Transactions & Idempotency...');
    const txId = `pg_tx_${Date.now()}`;
    const paymentResult = await repo.simulateVerifiedPayment(orderId, txId, 'REAL_UPI', 1200);

    expect(paymentResult.isDuplicate).toBe(false);
    expect(paymentResult.order.status).toBe('QUEUED');
    expect(paymentResult.order.paymentStatus).toBe('PAID');
    expect(paymentResult.job.status).toBe('QUEUED');

    // Duplicate webhook delivery with exact same txId
    const dupResult = await repo.simulateVerifiedPayment(orderId, txId, 'REAL_UPI', 1200);
    expect(dupResult.isDuplicate).toBe(true);
    expect(dupResult.job.id).toBe(paymentResult.job.id);

    // Verify DB unique constraint: Attempting to insert another job with same order_id directly must fail
    const { error: directJobDupError } = await rawSupabase.from('print_jobs').insert({
      order_id: orderId,
      status: 'QUEUED',
      print_options: {},
    });
    expect(directJobDupError).not.toBeNull();
    expect(directJobDupError?.code).toBe('23505'); // unique_violation
    console.log('  ✓ Payment idempotency verified; print_jobs.order_id unique constraint enforced.');

    // ------------------------------------------------------------------------
    // 4. Concurrent / Atomic Queue Claiming via PostgreSQL RPC
    // ------------------------------------------------------------------------
    console.log('▶ [4/6] Verifying Atomic Queue Claiming (FOR UPDATE SKIP LOCKED RPC)...');
    const agentAId = '00000000-0000-0000-0000-000000000002';
    const agentBId = '00000000-0000-0000-0000-000000000003';

    // Both agents claim simultaneously against real PostgreSQL database
    const [claimA, claimB] = await Promise.all([
      repo.claimNextPrintJob(agentAId),
      repo.claimNextPrintJob(agentBId),
    ]);

    const winningClaim = claimA || claimB;
    const losingClaim = claimA ? claimB : claimA;

    expect(winningClaim).not.toBeNull();
    expect(losingClaim).toBeNull();
    expect(winningClaim?.jobId).toBe(paymentResult.job.id);

    // Verify order transitioned to PRINTING in real database
    let dbOrder = await repo.getOrder(orderId);
    expect(dbOrder?.status).toBe('PRINTING');
    console.log('  ✓ claim_next_print_job RPC executed: exactly 1 agent won the atomic lock.');

    // ------------------------------------------------------------------------
    // 5. Agent Ownership & Status Update Lifecycle
    // ------------------------------------------------------------------------
    console.log('▶ [5/6] Verifying Agent Ownership & Order State Transitions...');
    const winningAgentId = claimA ? agentAId : agentBId;
    const rogueAgentId = claimA ? agentBId : agentAId;

    // Rogue agent attempts status update -> must fail
    await expect(
      repo.updateJobStatus(winningClaim!.jobId, rogueAgentId, { status: 'COMPLETED' })
    ).rejects.toThrow();

    // Winning agent updates to COMPLETED
    const completedJob = await repo.updateJobStatus(winningClaim!.jobId, winningAgentId, {
      status: 'COMPLETED',
    });
    expect(completedJob.status).toBe('COMPLETED');

    dbOrder = await repo.getOrder(orderId);
    expect(dbOrder?.status).toBe('COMPLETED');
    expect(dbOrder?.completedAt).toBeDefined();
    console.log('  ✓ Agent ownership enforced; Job & Order transitioned to COMPLETED.');

    // ------------------------------------------------------------------------
    // 6. Audit Trail Events Persistence
    // ------------------------------------------------------------------------
    console.log('▶ [6/6] Verifying Audit Event Trail in PostgreSQL...');
    const events = await repo.getOrderEvents(orderId);
    expect(events.length).toBeGreaterThanOrEqual(4);
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('FILE_RECEIVED');
    expect(eventTypes).toContain('PRINT_QUEUED');
    expect(eventTypes).toContain('STATUS_CHANGE_COMPLETED');
    console.log(`  ✓ Recorded ${events.length} audit events in print_order_events table.`);

    console.log('\n🎉 Real Supabase Integration Test Passed Successfully!\n');
  });
});