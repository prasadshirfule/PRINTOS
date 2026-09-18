import { getRepository } from '../src/lib/repository';
import { calculatePrintOrderPrice, PricingValidationError } from '../src/lib/pricing/pricing-engine';
import { parsePageRange, InvalidPageRangeError } from '../src/lib/pricing/page-range';
import { OrderStateMachine, InvalidStateTransitionError } from '../src/lib/orders/state-machine';
import { PrintOrder } from '../src/types/printos';

async function runPhase1AcceptanceTest() {
  console.log(`\n================================================================`);
  console.log(`🚀 PRINTOS PHASE 1 MASTER ACCEPTANCE SUITE (REPOSITORY ARCHITECTURE)`);
  console.log(`================================================================\n`);

  const repo = getRepository();
  if (repo.clear) {
    await repo.clear();
  }

  // --------------------------------------------------------------------------
  // STEP 1: Input Validation Invariants
  // --------------------------------------------------------------------------
  console.log(`▶ [1/7] Verifying Input Validation & Pricing Engine Invariants...`);

  // Invalid page range
  try {
    parsePageRange('5-1', 10);
    throw new Error('FAILED: Reversed page range "5-1" was not rejected!');
  } catch (err) {
    if (err instanceof InvalidPageRangeError) {
      console.log(`  ✓ Reversed range "5-1" properly rejected with InvalidPageRangeError`);
    } else throw err;
  }

  // Invalid copies
  try {
    calculatePrintOrderPrice({
      paperSize: 'A4',
      colorMode: 'BW',
      printSides: 'BOTH_SIDES',
      copies: 0,
      totalDocumentPages: 10,
    });
    throw new Error('FAILED: 0 copies was not rejected!');
  } catch (err) {
    if (err instanceof PricingValidationError) {
      console.log(`  ✓ 0 copies properly rejected with PricingValidationError`);
    } else throw err;
  }

  // Invalid state transition
  try {
    OrderStateMachine.validateTransition('RECEIVED', 'PRINTING');
    throw new Error('FAILED: Illegal transition RECEIVED -> PRINTING was not rejected!');
  } catch (err) {
    if (err instanceof InvalidStateTransitionError) {
      console.log(`  ✓ Illegal transition RECEIVED -> PRINTING properly rejected`);
    } else throw err;
  }

  // --------------------------------------------------------------------------
  // STEP 2: Create Test Order & Configure
  // --------------------------------------------------------------------------
  console.log(`\n▶ [2/7] Creating Order & Configuring Specifications...`);
  const orderId = 'order-acceptance-001';
  const orderNumber = 'P1042';

  const priceResult = calculatePrintOrderPrice({
    paperSize: 'A4',
    colorMode: 'BW',
    printSides: 'BOTH_SIDES',
    copies: 2,
    totalDocumentPages: 12,
    pageSelection: null, // All pages
  });

  console.log(`  ✓ Options: A4 | B&W | Duplex | 2 copies | 12 pages`);
  console.log(`  ✓ Price Calculated: ₹${(priceResult.totalAmountPaisa / 100).toFixed(2)} (${priceResult.totalAmountPaisa} paisa)`);

  const order: PrintOrder = {
    id: orderId,
    orderNumber,
    customerPhone: '919876543210',
    customerName: 'Rohit Sharma',
    status: 'RECEIVED',
    originalFilename: 'assignment.pdf',
    storagePath: `orders/${orderId}/assignment.pdf`,
    fileType: 'pdf',
    fileSize: 1540000,
    pageCount: 12,
    paperSize: 'A4',
    colorMode: 'BW',
    printSides: 'BOTH_SIDES',
    copies: 2,
    pageSelection: null,
    selectedPageCount: 12,
    subtotalPaisa: priceResult.subtotalPaisa,
    discountPaisa: priceResult.discountPaisa,
    totalAmountPaisa: priceResult.totalAmountPaisa,
    currency: 'INR',
    paymentStatus: 'PENDING',
    createdAt: new Date().toISOString(),
  };

  await repo.createOrder(order);
  await repo.updateOrderStatus(orderId, 'CONFIGURING');
  await repo.updateOrderStatus(orderId, 'AWAITING_PAYMENT');
  console.log(`  ✓ Order transitioned via Repository: RECEIVED -> CONFIGURING -> AWAITING_PAYMENT`);

  // --------------------------------------------------------------------------
  // STEP 3: Simulate Verified Payment & Automatic Print Job Creation
  // --------------------------------------------------------------------------
  console.log(`\n▶ [3/7] Simulating Verified Payment Webhook...`);
  const txId = 'upi_txn_98234120';
  const payResult = await repo.simulateVerifiedPayment(orderId, txId, 'MOCK_UPI', priceResult.totalAmountPaisa);

  if (payResult.order.status !== 'QUEUED') {
    throw new Error(`Expected order status QUEUED, received: ${payResult.order.status}`);
  }
  if (payResult.job.status !== 'QUEUED') {
    throw new Error(`Expected job status QUEUED, received: ${payResult.job.status}`);
  }
  console.log(`  ✓ Order marked PAID & transitioned to QUEUED`);
  console.log(`  ✓ Print Job #${payResult.job.id} created with status QUEUED`);

  // --------------------------------------------------------------------------
  // STEP 4: Test Idempotency (Duplicate Webhook Delivery)
  // --------------------------------------------------------------------------
  console.log(`\n▶ [4/7] Testing Payment Webhook Idempotency (Duplicate Webhooks)...`);
  const dupResult1 = await repo.simulateVerifiedPayment(orderId, txId, 'MOCK_UPI', priceResult.totalAmountPaisa);
  const dupResult2 = await repo.simulateVerifiedPayment(orderId, txId, 'MOCK_UPI', priceResult.totalAmountPaisa);

  if (!dupResult1.isDuplicate || !dupResult2.isDuplicate) {
    throw new Error('FAILED: Duplicate payment webhook was not flagged as duplicate!');
  }
  const allJobs = await repo.listJobs();
  if (allJobs.length !== 1) {
    throw new Error(`FAILED: Expected exactly 1 print job, found ${allJobs.length}!`);
  }
  console.log(`  ✓ Repeated webhooks recognized as duplicate. Exactly 1 print job exists.`);

  // --------------------------------------------------------------------------
  // STEP 5: Test Concurrency (Two Agents Claiming Simultaneously)
  // --------------------------------------------------------------------------
  console.log(`\n▶ [5/7] Testing Queue Claim Atomicity (2 Agents Claiming Simultaneously)...`);
  const [claimA, claimB] = await Promise.all([
    repo.claimNextPrintJob('agent-node-alpha'),
    repo.claimNextPrintJob('agent-node-beta'),
  ]);

  const winningClaim = claimA || claimB;
  const losingClaim = claimA ? claimB : claimA;

  if (!winningClaim || losingClaim !== null) {
    throw new Error(`FAILED: Race condition detected! One job was claimed by both or neither agent.`);
  }
  console.log(`  ✓ Atomic lock succeeded: Winning agent claimed Job #${winningClaim.jobId}; second agent received null.`);

  // --------------------------------------------------------------------------
  // STEP 6: Execute Job Lifecycle via Print Agent
  // --------------------------------------------------------------------------
  console.log(`\n▶ [6/7] Mock Print Agent Execution (PRINTING -> COMPLETED)...`);
  const currentOrder = await repo.getOrder(orderId);
  if (currentOrder?.status !== 'PRINTING') {
    throw new Error(`Expected order status PRINTING during claim, got: ${currentOrder?.status}`);
  }
  console.log(`  ✓ Order status is automatically PRINTING`);

  // Simulate hardware printing completion with agent authorization check
  const winningAgentId = claimA ? 'agent-node-alpha' : 'agent-node-beta';
  await repo.updateJobStatus(winningClaim.jobId, winningAgentId, { status: 'COMPLETED' });
  const finalOrder = await repo.getOrder(orderId);
  const finalJob = await repo.getJob(winningClaim.jobId);

  if (finalJob?.status !== 'COMPLETED') {
    throw new Error(`Expected final job status COMPLETED, got: ${finalJob?.status}`);
  }
  if (finalOrder?.status !== 'COMPLETED') {
    throw new Error(`Expected final order status COMPLETED, got: ${finalOrder?.status}`);
  }
  console.log(`  ✓ Job & Order successfully transitioned to COMPLETED`);

  // --------------------------------------------------------------------------
  // STEP 7: Verify Audit Trail & Metrics
  // --------------------------------------------------------------------------
  console.log(`\n▶ [7/7] Verifying Audit Event Trail & Dashboard Metrics...`);
  const events = await repo.getOrderEvents(orderId);
  console.log(`  ✓ Recorded ${events.length} audit events:`);
  events.forEach((ev) => console.log(`    • [${ev.eventType}] ${ev.message}`));

  const metrics = await repo.getDashboardMetrics();
  console.log(`  ✓ Dashboard Metrics: Completed: ${metrics.completed}, Revenue: ₹${(metrics.revenuePaisa / 100).toFixed(2)}, Pages: ${metrics.pagesPrinted}`);

  if (metrics.completed !== 1 || metrics.revenuePaisa !== 4800) {
    throw new Error(`Metrics assertion failed!`);
  }

  console.log(`\n================================================================`);
  console.log(`🎉 ALL PHASE 1 ACCEPTANCE TESTS PASSED SUCCESSFULLY!`);
  console.log(`================================================================\n`);
}

runPhase1AcceptanceTest().catch((err) => {
  console.error('\n❌ ACCEPTANCE TEST FAILED:', err);
  process.exit(1);
});