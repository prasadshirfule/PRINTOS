import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryPrintOSRepository, StaleConversationVersionError } from '@/lib/repository';
import { WhatsAppStateMachine } from '@/lib/whatsapp/state-machine';
import { InboundWhatsAppEvent } from '@/types/whatsapp';

describe('Phase 2: WhatsApp State Machine', () => {
  let repo: InMemoryPrintOSRepository;
  const phone = '919876543210';

  beforeEach(async () => {
    repo = new InMemoryPrintOSRepository();
  });

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

  it('initializes from IDLE to AWAITING_DOCUMENT on greeting', async () => {
    const event = makeEvent('text', 'Hi, I want to print a file');
    const conv = await WhatsAppStateMachine.processEvent(event, repo);

    expect(conv.currentState).toBe('AWAITING_DOCUMENT');
    expect(conv.customerPhone).toBe(phone);

    const outbox = await repo.claimOutboxBatch('worker_test', 10);
    expect(outbox.length).toBeGreaterThan(0);
    expect(outbox[0].recipientPhone).toBe(phone);
    expect(outbox[0].payload.text || outbox[0].payload.body).toContain('PRINTOS');
  });

  it('transitions through full order configuration flow to AWAITING_PAYMENT', async () => {
    // 1. Initial Greeting
    await WhatsAppStateMachine.processEvent(makeEvent('text', 'Hello'), repo);

    // 2. Upload Document (5 pages PDF)
    const docEvent = makeEvent('document', undefined, undefined, {
      filename: 'lecture_notes.pdf',
      mimeType: 'application/pdf',
      fileSize: 1048576,
      rawPayload: {
        storagePath: `whatsapp/${phone}/doc_123_lecture_notes.pdf`,
        pageCount: 5,
        fileType: 'pdf',
      },
    });
    const convAfterDoc = await WhatsAppStateMachine.processEvent(docEvent, repo);
    expect(convAfterDoc.currentState).toBe('COLLECTING_COLOR');
    expect(convAfterDoc.sessionData.pageCount).toBe(5);

    // 3. Select Color (BW)
    const colorEvent = makeEvent('button', 'Black & White', 'btn_bw');
    const convAfterColor = await WhatsAppStateMachine.processEvent(colorEvent, repo);
    expect(convAfterColor.currentState).toBe('COLLECTING_SIDES');
    expect(convAfterColor.sessionData.colorMode).toBe('BW');

    // 4. Select Print Sides (Double-Sided)
    const sidesEvent = makeEvent('button', 'Double-Sided', 'btn_duplex');
    const convAfterSides = await WhatsAppStateMachine.processEvent(sidesEvent, repo);
    expect(convAfterSides.currentState).toBe('COLLECTING_COPIES');
    expect(convAfterSides.sessionData.printSides).toBe('BOTH_SIDES');

    // 5. Select Copies (2 copies)
    const copiesEvent = makeEvent('text', '2');
    const convAfterCopies = await WhatsAppStateMachine.processEvent(copiesEvent, repo);
    expect(convAfterCopies.currentState).toBe('COLLECTING_PAGES');
    expect(convAfterCopies.sessionData.copies).toBe(2);

    // 6. Select Pages (all)
    const pagesEvent = makeEvent('button', 'All Pages', 'btn_all_pages');
    const convAfterPages = await WhatsAppStateMachine.processEvent(pagesEvent, repo);
    expect(convAfterPages.currentState).toBe('CONFIRMING_ORDER');
    expect(convAfterPages.sessionData.totalAmountPaisa).toBeGreaterThan(0);

    // 7. Confirm Order
    const confirmEvent = makeEvent('button', 'Confirm & Pay', 'btn_confirm_order');
    const convAfterConfirm = await WhatsAppStateMachine.processEvent(confirmEvent, repo);
    expect(convAfterConfirm.currentState).toBe('AWAITING_PAYMENT');
    expect(convAfterConfirm.activeOrderId).toBeDefined();

    // Verify order in repo
    const order = await repo.getOrder(convAfterConfirm.activeOrderId!);
    expect(order).toBeDefined();
    expect(order!.status).toBe('AWAITING_PAYMENT');
    expect(order!.customerPhone).toBe(phone);
    expect(order!.copies).toBe(2);
    expect(order!.pageCount).toBe(5);
  });

  it('handles cancellation and resets conversation to IDLE', async () => {
    // Start flow
    await WhatsAppStateMachine.processEvent(makeEvent('text', 'Hi'), repo);
    const conv = await repo.getConversation(phone);
    expect(conv?.currentState).toBe('AWAITING_DOCUMENT');

    // Send cancel
    const cancelEvent = makeEvent('text', 'cancel');
    const updatedConv = await WhatsAppStateMachine.processEvent(cancelEvent, repo);

    expect(updatedConv.currentState).toBe('CANCELLED');
    expect(updatedConv.sessionData.originalFilename).toBeUndefined();
    expect(updatedConv.sessionData.documentPath).toBeUndefined();
  });

  it('rejects invalid page selection with helpful error and preserves state', async () => {
    await WhatsAppStateMachine.processEvent(makeEvent('text', 'Hi'), repo);
    await WhatsAppStateMachine.processEvent(
      makeEvent('document', undefined, undefined, {
        filename: 'report.pdf',
        rawPayload: { storagePath: 'whatsapp/path.pdf', pageCount: 3, fileType: 'pdf' },
      }),
      repo
    );
    await WhatsAppStateMachine.processEvent(makeEvent('button', 'BW', 'btn_bw'), repo);
    await WhatsAppStateMachine.processEvent(makeEvent('button', 'Single', 'btn_single'), repo);
    await WhatsAppStateMachine.processEvent(makeEvent('text', '1'), repo);

    const conv = await repo.getConversation(phone);
    expect(conv?.currentState).toBe('COLLECTING_PAGES');

    // Invalid page range (page 10 on a 3-page document)
    const invalidPages = makeEvent('text', '1-10');
    const res = await WhatsAppStateMachine.processEvent(invalidPages, repo);

    expect(res.currentState).toBe('COLLECTING_PAGES'); // Remains in state for retry
  });

  it('rejects invalid copy count (e.g. 0 or 1000)', async () => {
    await WhatsAppStateMachine.processEvent(makeEvent('text', 'Hi'), repo);
    await WhatsAppStateMachine.processEvent(
      makeEvent('document', undefined, undefined, {
        filename: 'doc.pdf',
        rawPayload: { storagePath: 'whatsapp/path.pdf', pageCount: 1, fileType: 'pdf' },
      }),
      repo
    );
    await WhatsAppStateMachine.processEvent(makeEvent('button', 'BW', 'btn_bw'), repo);
    await WhatsAppStateMachine.processEvent(makeEvent('button', 'Single', 'btn_single'), repo);

    // Invalid copies
    const invalidCopies = makeEvent('text', '0');
    const res = await WhatsAppStateMachine.processEvent(invalidCopies, repo);
    expect(res.currentState).toBe('COLLECTING_COPIES');
  });

  it('resets expired conversation when inactivity TTL (15m) has elapsed', async () => {
    // Start flow
    await WhatsAppStateMachine.processEvent(makeEvent('text', 'Hi'), repo);
    const conv = await repo.getConversation(phone);
    expect(conv?.currentState).toBe('AWAITING_DOCUMENT');

    // Manually backdate lastInteractionAt by 20 minutes
    conv!.lastInteractionAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await repo.upsertConversation(conv!);

    // New interaction should notice expiration and restart from IDLE -> AWAITING_DOCUMENT
    const newEvent = makeEvent('text', 'hello again');
    const updated = await WhatsAppStateMachine.processEvent(newEvent, repo);
    expect(updated.currentState).toBe('AWAITING_DOCUMENT');
  });

  it('persists inbound WhatsApp LID ("20495684599884@lid") and routes replies to exact LID target', async () => {
    const lidChatId = '20495684599884@lid';
    const lidEvent: InboundWhatsAppEvent = {
      wamid: 'wamid_lid_test_001',
      from: lidChatId,
      name: 'Privacy User',
      timestamp: Date.now(),
      type: 'text',
      text: 'Hi',
      rawPayload: {},
    };

    const conv = await WhatsAppStateMachine.processEvent(lidEvent, repo);
    expect(conv.whatsappChatId).toBe(lidChatId);
    expect(conv.sessionData.whatsappChatId).toBe(lidChatId);

    // Retrieve conversation by either LID or customer phone
    const fetchedByLid = await repo.getConversation(lidChatId);
    expect(fetchedByLid).toBeDefined();
    expect(fetchedByLid?.whatsappChatId).toBe(lidChatId);

    // Verify outbox queued reply recipient is EXACTLY the LID
    const outboxBatch = await repo.claimOutboxBatch('worker_reg_test', 10);
    expect(outboxBatch.length).toBeGreaterThan(0);
    expect(outboxBatch[0].recipientPhone).toBe(lidChatId);
  });

  it('preserves WhatsApp group identity ("120363000000000000@g.us") for replies', async () => {
    const groupChatId = '120363000000000000@g.us';
    const groupEvent: InboundWhatsAppEvent = {
      wamid: 'wamid_group_test_001',
      from: groupChatId,
      name: 'Campus Print Group',
      timestamp: Date.now(),
      type: 'text',
      text: 'Hi',
      rawPayload: {},
    };

    const conv = await WhatsAppStateMachine.processEvent(groupEvent, repo);
    expect(conv.whatsappChatId).toBe(groupChatId);

    const outboxBatch = await repo.claimOutboxBatch('worker_group_test', 10);
    expect(outboxBatch.length).toBeGreaterThan(0);
    expect(outboxBatch[0].recipientPhone).toBe(groupChatId);
  });

  it('preserves standard phone JID ("919876543210@c.us") for replies', async () => {
    const phoneChatId = '919876543210@c.us';
    const cusEvent: InboundWhatsAppEvent = {
      wamid: 'wamid_cus_test_001',
      from: phoneChatId,
      name: 'Standard User',
      timestamp: Date.now(),
      type: 'text',
      text: 'Hi',
      rawPayload: {},
    };

    const conv = await WhatsAppStateMachine.processEvent(cusEvent, repo);
    expect(conv.whatsappChatId).toBe(phoneChatId);

    const outboxBatch = await repo.claimOutboxBatch('worker_cus_test', 10);
    expect(outboxBatch.length).toBeGreaterThan(0);
    expect(outboxBatch[0].recipientPhone).toBe(phoneChatId);
  });

  it('ensures numeric customerPhone does NOT override whatsappChatId transport recipient', async () => {
    // Existing conversation has numeric customerPhone "20495684599884" and whatsappChatId "20495684599884@lid"
    await repo.upsertConversation({
      customerPhone: '20495684599884',
      whatsappChatId: '20495684599884@lid',
      currentState: 'IDLE',
      sessionData: { whatsappChatId: '20495684599884@lid' },
    });

    const event: InboundWhatsAppEvent = {
      wamid: 'wamid_doc_lid_002',
      from: '20495684599884@lid',
      timestamp: Date.now(),
      type: 'document',
      filename: 'thesis.pdf',
      mimeType: 'application/pdf',
      rawPayload: { pageCount: 1, fileType: 'pdf' },
    };

    const updated = await WhatsAppStateMachine.processEvent(event, repo);
    expect(updated.customerPhone).toBe('20495684599884');
    expect(updated.whatsappChatId).toBe('20495684599884@lid');

    const outboxBatch = await repo.claimOutboxBatch('worker_override_test', 10);
    expect(outboxBatch.length).toBeGreaterThan(0);
    // Transport recipient must be the LID, not the numeric phone
    expect(outboxBatch[0].recipientPhone).toBe('20495684599884@lid');
  });

  it('handles legacy customer_phone conversation lookup and attaches whatsappChatId', async () => {
    // Legacy conversation created with plain customer_phone without whatsappChatId
    const legacyConv = await repo.upsertConversation({
      customerPhone: '919876543210',
      currentState: 'IDLE',
      sessionData: {},
    });
    expect(legacyConv.whatsappChatId).toBeNull();

    // Querying with @c.us should match legacy conversation by phone digits and attach whatsappChatId
    const foundByCus = await repo.getConversation('919876543210@c.us');
    expect(foundByCus).toBeDefined();
    expect(foundByCus?.id).toBe(legacyConv.id);
    expect(foundByCus?.whatsappChatId).toBe('919876543210@c.us');
  });

  it('prevents collisions between LID and numeric phone numbers with same digits', async () => {
    // Distinct conversation 1: numeric phone customer
    const convPhone = await repo.upsertConversation({
      customerPhone: '20495684599884',
      whatsappChatId: '20495684599884@c.us',
      currentState: 'IDLE',
      sessionData: {},
    });

    // Distinct conversation 2: LID customer
    const convLid = await repo.upsertConversation({
      customerPhone: '20495684599884@lid',
      whatsappChatId: '20495684599884@lid',
      currentState: 'IDLE',
      sessionData: {},
    });

    // Lookups must return the exact, distinct conversations without ambiguity
    const retrievedLid = await repo.getConversation('20495684599884@lid');
    expect(retrievedLid?.id).toBe(convLid.id);
    expect(retrievedLid?.whatsappChatId).toBe('20495684599884@lid');

    const retrievedPhone = await repo.getConversation('20495684599884@c.us');
    expect(retrievedPhone?.id).toBe(convPhone.id);
    expect(retrievedPhone?.whatsappChatId).toBe('20495684599884@c.us');

    const retrievedByDigits = await repo.getConversation('20495684599884');
    expect(retrievedByDigits?.id).toBe(convPhone.id);
  });
});
