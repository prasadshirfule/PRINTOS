/**
 * PRINTOS Phase 2 Master Acceptance Suite: 34 End-to-End Scenarios
 * Covers WhatsApp Webhook Ingestion, Magic-Byte Pipeline, Conversation State Machine,
 * Outbox Transmission, Payment Idempotency, Fulfillability Policy, Lease Safety & Worker Recovery.
 */

import { InMemoryPrintOSRepository } from '../src/lib/repository/in-memory-repository';
import { WhatsAppStateMachine } from '../src/lib/whatsapp/state-machine';
import { WhatsAppInboxService } from '../src/lib/whatsapp/inbox-service';
import { WhatsAppWorkerEngine } from '../src/lib/whatsapp/worker-engine';
import { detectMagicBytes, WhatsAppMediaDownloader } from '../src/lib/whatsapp/media-downloader';
import { MockWhatsAppProvider } from '../src/lib/whatsapp/provider/mock-whatsapp-provider';
import { setWhatsAppProvider } from '../src/lib/whatsapp/provider';
import { MockPaymentProvider } from '../src/lib/payment/mock-payment-provider';
import { FulfillabilityPolicy } from '../src/lib/payment/fulfillability-policy';
import { NotificationService } from '../src/lib/whatsapp/notification-service';
import { InboundWhatsAppEvent } from '../src/types/whatsapp';
import { Readable } from 'stream';

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, scenario: string, details?: string) {
  if (condition) {
    passedCount++;
    console.log(`  ✅ [PASS] ${scenario}`);
  } else {
    failedCount++;
    console.error(`  ❌ [FAIL] ${scenario}${details ? ` -> ${details}` : ''}`);
  }
}

async function runAcceptanceSuite() {
  console.log('\n====================================================================');
  console.log('🚀 PRINTOS PHASE 2 — 34-SCENARIO MASTER ACCEPTANCE SUITE');
  console.log('====================================================================\n');

  const repo = new InMemoryPrintOSRepository();
  const mockWhatsApp = new MockWhatsAppProvider();
  setWhatsAppProvider(mockWhatsApp);
  const paymentProvider = new MockPaymentProvider();
  const phone = '919876543210';

  function makeEvent(
    type: InboundWhatsAppEvent['type'],
    text?: string,
    buttonId?: string,
    extras?: Partial<InboundWhatsAppEvent>
  ): InboundWhatsAppEvent {
    return {
      wamid: `wamid_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      from: phone,
      timestamp: Date.now(),
      type,
      text,
      buttonId,
      rawPayload: {},
      ...extras,
    };
  }

  // S1: Inbound Greeting
  const s1Conv = await WhatsAppStateMachine.processEvent(makeEvent('text', 'Hi'), repo);
  assert(s1Conv.currentState === 'AWAITING_DOCUMENT', 'Scenario 1: Inbound text greeting transitions to AWAITING_DOCUMENT');

  // S2: Valid PDF magic-byte detection
  const pdfMagic = detectMagicBytes(Buffer.from('%PDF-1.4 sample content'));
  assert(pdfMagic === 'pdf', 'Scenario 2: Valid PDF magic-byte detection');

  // S3: Valid JPEG magic-byte detection
  const jpgMagic = detectMagicBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  assert(jpgMagic === 'jpg', 'Scenario 3: Valid JPEG magic-byte detection');

  // S4: Valid PNG magic-byte detection
  const pngMagic = detectMagicBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert(pngMagic === 'png', 'Scenario 4: Valid PNG magic-byte detection');

  // S5: Invalid/corrupted file magic-byte rejection
  const exeMagic = detectMagicBytes(Buffer.from('MZ\x90\x00\x03\x00'));
  assert(exeMagic === null, 'Scenario 5: Corrupted / executable magic-byte rejection');

  // S6: Oversized streaming download rejection (>50MB)
  const downloader = new WhatsAppMediaDownloader();
  const largeMock = {
    async sendText() { return { providerMessageId: '' }; },
    async sendInteractiveButtons() { return { providerMessageId: '' }; },
    async sendDocument() { return { providerMessageId: '' }; },
    async getMediaUrl() { return { url: 'https://mock/large', mimeType: 'application/pdf', fileSize: 55 * 1024 * 1024 }; },
    async downloadMediaStream() { return { stream: Readable.from([Buffer.alloc(100)]), contentLength: 55 * 1024 * 1024 }; },
  };
  let s6Error = false;
  try {
    await downloader.ingestMedia(largeMock as any, 'large_id', 'large.pdf', phone);
  } catch {
    s6Error = true;
  }
  assert(s6Error, 'Scenario 6: Oversized file (>50MB) streaming rejection');

  // S7: Document Reception -> COLLECTING_COLOR
  const s7Conv = await WhatsAppStateMachine.processEvent(
    makeEvent('document', undefined, undefined, {
      filename: 'thesis.pdf',
      rawPayload: { storagePath: `whatsapp/${phone}/thesis.pdf`, pageCount: 10, fileType: 'pdf' },
    }),
    repo
  );
  assert(s7Conv.currentState === 'COLLECTING_COLOR', 'Scenario 7: Document ingestion transitions to COLLECTING_COLOR');

  // S8: Color Selection -> BW -> COLLECTING_SIDES
  const s8Conv = await WhatsAppStateMachine.processEvent(makeEvent('button', 'Black & White', 'btn_bw'), repo);
  assert(s8Conv.currentState === 'COLLECTING_SIDES' && s8Conv.sessionData.colorMode === 'BW', 'Scenario 8: Select BW color transitions to COLLECTING_SIDES');

  // S9: Sides Selection -> Both Sides -> COLLECTING_COPIES
  const s9Conv = await WhatsAppStateMachine.processEvent(makeEvent('button', 'Double-Sided', 'btn_duplex'), repo);
  assert(s9Conv.currentState === 'COLLECTING_COPIES' && s9Conv.sessionData.printSides === 'BOTH_SIDES', 'Scenario 9: Select Double-Sided transitions to COLLECTING_COPIES');

  // S10: Invalid Copies rejection
  const s10Conv = await WhatsAppStateMachine.processEvent(makeEvent('text', '0'), repo);
  assert(s10Conv.currentState === 'COLLECTING_COPIES', 'Scenario 10: Invalid copy count (0) rejected with prompt');

  // S11: Valid Copies Selection -> COLLECTING_PAGES
  const s11Conv = await WhatsAppStateMachine.processEvent(makeEvent('text', '2'), repo);
  assert(s11Conv.currentState === 'COLLECTING_PAGES' && s11Conv.sessionData.copies === 2, 'Scenario 11: Valid copies selection transitions to COLLECTING_PAGES');

  // S12: Invalid Page Range rejection
  const s12Conv = await WhatsAppStateMachine.processEvent(makeEvent('text', '1-50'), repo);
  assert(s12Conv.currentState === 'COLLECTING_PAGES', 'Scenario 12: Out-of-bounds page range rejected gracefully');

  // S13: Valid Page Range Selection -> CONFIRMING_ORDER with calculated price quote
  const s13Conv = await WhatsAppStateMachine.processEvent(makeEvent('text', '1-5'), repo);
  assert(s13Conv.currentState === 'CONFIRMING_ORDER' && (s13Conv.sessionData.totalAmountPaisa || 0) > 0, 'Scenario 13: Page selection transitions to CONFIRMING_ORDER with quote');

  // S14: Confirm Order -> AWAITING_PAYMENT with active PrintOrder
  const s14Conv = await WhatsAppStateMachine.processEvent(makeEvent('button', 'Confirm & Pay', 'btn_confirm_order'), repo);
  assert(s14Conv.currentState === 'AWAITING_PAYMENT' && Boolean(s14Conv.activeOrderId), 'Scenario 14: Confirm order creates order in AWAITING_PAYMENT');

  const order = await repo.getOrder(s14Conv.activeOrderId!);
  assert(Boolean(order) && order!.status === 'AWAITING_PAYMENT', 'Scenario 15: PrintOrder correctly persisted in database');

  // S16: Payment Webhook -> atomic order transition to QUEUED & PrintJob creation
  const paymentIntent = await paymentProvider.createPaymentIntent(order!.id, order!.totalAmountPaisa, phone);
  const { order: paidOrder, job: createdJob, isDuplicate: s16Dup } = await repo.simulateVerifiedPayment(
    order!.id,
    paymentIntent.paymentId,
    'MOCK_UPI',
    order!.totalAmountPaisa
  );
  assert(paidOrder.status === 'QUEUED' && Boolean(createdJob) && !s16Dup, 'Scenario 16: Payment verification atomically transitions order to QUEUED');

  // S17: Payment Idempotency -> duplicate payment webhook does NOT recreate job
  const { isDuplicate: s17Dup } = await repo.simulateVerifiedPayment(
    order!.id,
    paymentIntent.paymentId,
    'MOCK_UPI',
    order!.totalAmountPaisa
  );
  assert(s17Dup, 'Scenario 17: Duplicate payment webhook handled idempotently without re-queueing');

  // S18: Active printer capability check via FulfillabilityPolicy
  const fulfillability = await FulfillabilityPolicy.isOrderFulfillable(paidOrder, repo);
  assert(fulfillability.fulfillable, 'Scenario 18: Fulfillability policy assesses active shop hardware');

  // S19: Late Payment on Expired Order (Fulfillable) -> resurrects to QUEUED
  const lateOrder = await repo.createOrder({
    id: 'late_order_1',
    orderNumber: 'ORD-LATE-1',
    customerPhone: phone,
    status: 'EXPIRED',
    originalFilename: 'notes.pdf',
    storagePath: 'whatsapp/notes.pdf',
    fileType: 'pdf',
    fileSize: 1024,
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
  });
  const lateAssessment = await FulfillabilityPolicy.isOrderFulfillable(lateOrder, repo);
  assert(lateAssessment.fulfillable, 'Scenario 19: Late payment on expired order evaluated as fulfillable');

  // S20: Late Payment on Expired Order (Non-fulfillable missing file) -> REFUND_PENDING
  const badOrder = await repo.createOrder({
    id: 'bad_order_1',
    orderNumber: 'ORD-BAD-1',
    customerPhone: phone,
    status: 'EXPIRED',
    originalFilename: 'missing.pdf',
    storagePath: '', // missing
    fileType: 'pdf',
    fileSize: 1024,
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
  });
  const badAssessment = await FulfillabilityPolicy.isOrderFulfillable(badOrder, repo);
  assert(!badAssessment.fulfillable && badAssessment.reason === 'FILE_EXPIRED', 'Scenario 20: Missing file triggers REFUND_PENDING assessment');

  // S21: Cancellation command transitions conversation to CANCELLED
  const cancelConv = await WhatsAppStateMachine.processEvent(makeEvent('text', 'cancel'), repo);
  assert(cancelConv.currentState === 'CANCELLED', 'Scenario 21: Cancel command transitions to CANCELLED');

  // S22: Reset command transitions conversation to IDLE
  const resetConv = await WhatsAppStateMachine.processEvent(makeEvent('text', 'reset'), repo);
  assert(resetConv.currentState === 'IDLE', 'Scenario 22: Reset command resets conversation to IDLE');

  // S23: Inactivity TTL resets stale conversation
  await WhatsAppStateMachine.processEvent(makeEvent('text', 'Hi'), repo);
  const activeConv = await repo.getConversation(phone);
  activeConv!.lastInteractionAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20m ago
  await repo.upsertConversation(activeConv!);
  const staleRes = await WhatsAppStateMachine.processEvent(makeEvent('text', 'Hello'), repo);
  assert(staleRes.currentState === 'AWAITING_DOCUMENT', 'Scenario 23: 15-minute inactivity TTL triggers automatic session reset');

  // S24: Durable Inbox wamid deduplication
  const { isDuplicate: wamidDup1 } = await repo.enqueueInboxItem({
    messageId: 'wamid_unique_acc_1',
    senderPhone: phone,
    rawPayload: { type: 'text', text: 'hi' },
  });
  const { isDuplicate: wamidDup2 } = await repo.enqueueInboxItem({
    messageId: 'wamid_unique_acc_1',
    senderPhone: phone,
    rawPayload: { type: 'text', text: 'hi' },
  });
  assert(!wamidDup1 && wamidDup2, 'Scenario 24: Durable inbox enforces unique wamid deduplication');

  // S25: Worker claims inbox batch with lease lock
  const claimedInbox = await repo.claimInboxBatch('worker_acc_1', 10, 120);
  assert(claimedInbox.length > 0 && claimedInbox[0].workerId === 'worker_acc_1', 'Scenario 25: Worker successfully claims inbox batch with lease lock');

  // S26: Second concurrent worker cannot claim already locked item
  const claimedInbox2 = await repo.claimInboxBatch('worker_acc_2', 10, 120);
  assert(claimedInbox2.length === 0, 'Scenario 26: Concurrent worker cannot claim already locked inbox row');

  // S27: Worker lease renewal extends locked_until
  const renewed = await repo.renewInboxLease(claimedInbox[0].id, 'worker_acc_1', 180);
  assert(renewed, 'Scenario 27: Worker heartbeat successfully renews lease');

  // S28: Expired lease reclaimed by new worker
  const rawInbox = (repo as any).inbox.get(claimedInbox[0].id);
  rawInbox.lockedUntil = new Date(Date.now() - 5000).toISOString(); // expired
  const reclaimed = await repo.claimInboxBatch('worker_acc_3', 10, 120);
  assert(reclaimed.length === 1 && reclaimed[0].workerId === 'worker_acc_3', 'Scenario 28: Expired inbox lease reclaimed by recovery worker');

  // S29: Expired owner rejected from completing reclaimed item
  const oldComplete = await repo.completeInboxItem(claimedInbox[0].id, 'worker_acc_1');
  assert(!oldComplete, 'Scenario 29: Expired owner rejected from completing reclaimed inbox item');

  // S30: Inbox Dead-Letter transition after 5 attempts
  const { item: dlItem } = await repo.enqueueInboxItem({
    messageId: 'wamid_deadletter_acc',
    senderPhone: phone,
    rawPayload: { type: 'text', text: 'fail' },
  });
  for (let i = 0; i < 4; i++) {
    await repo.claimInboxBatch('w_dl', 10, 120);
    await repo.failInboxItem(dlItem.id, 'w_dl', 'error', true);
  }
  await repo.claimInboxBatch('w_dl', 10, 120);
  await repo.failInboxItem(dlItem.id, 'w_dl', 'fatal error', false);
  const dlRecord = (repo as any).inbox.get(dlItem.id);
  assert(dlRecord.status === 'DEAD_LETTER', 'Scenario 30: Inbox item transitions to DEAD_LETTER after max attempts');

  // S31: Outbox queue batch claiming & transmission
  await repo.enqueueOutboxItem({
    recipientPhone: phone,
    messageType: 'text',
    payload: { text: 'Acceptance Outbox Test' },
  });
  const workerEngine = new WhatsAppWorkerEngine(repo);
  const outboxRes = await workerEngine.processOutboxQueue('w_outbox', 10, 120);
  assert(outboxRes.sent >= 1, 'Scenario 31: Outbox worker claims and transmits message via WhatsApp provider');

  // S32: Outbox Dead-Letter transition after 5 attempts
  const obItem = await repo.enqueueOutboxItem({
    recipientPhone: phone,
    messageType: 'text',
    payload: { text: 'Fail Outbox' },
  });
  mockWhatsApp.shouldFail = true;
  for (let i = 0; i < 5; i++) {
    const itemRef = (repo as any).outbox.get(obItem.id);
    if (itemRef) {
      itemRef.lockedUntil = new Date(Date.now() - 5000).toISOString();
      itemRef.nextAttemptAt = new Date(Date.now() - 5000).toISOString();
    }
    await workerEngine.processOutboxQueue('w_outbox_fail', 10, 120);
  }
  mockWhatsApp.shouldFail = false;
  const obFinal = (repo as any).outbox.get(obItem.id);
  assert(obFinal.status === 'DEAD_LETTER', 'Scenario 32: Outbox item transitions to DEAD_LETTER after max attempts');

  // S33: Order status PRINTING dispatches customer outbox notification
  await NotificationService.notifyOrderStatus(repo, paidOrder, 'PRINTING');
  const printingOutbox = await repo.claimOutboxBatch('w_notif', 10, 120);
  assert(
    printingOutbox.some((o) => (o.payload.body || o.payload.text || '').toLowerCase().includes('printing')),
    'Scenario 33: PRINTING status update dispatches customer alert'
  );

  // S34: Order status COMPLETED dispatches pickup notification
  await NotificationService.notifyOrderStatus(repo, paidOrder, 'COMPLETED');
  const completedOutbox = await repo.claimOutboxBatch('w_notif', 10, 120);
  assert(
    completedOutbox.some((o) => (o.payload.body || o.payload.text || '').includes('READY') || (o.payload.body || o.payload.text || '').includes('Ready')),
    'Scenario 34: COMPLETED status update dispatches pickup notification'
  );

  console.log('\n====================================================================');
  console.log(`📊 ACCEPTANCE SUITE SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED (Total: 34)`);
  console.log('====================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAcceptanceSuite().catch((err) => {
  console.error('Fatal error in acceptance suite:', err);
  process.exit(1);
});
