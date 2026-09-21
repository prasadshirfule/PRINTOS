import {
  ConversationState,
  ConversationSessionData,
  InboundWhatsAppEvent,
  WhatsAppConversation,
} from '@/types/whatsapp';
import { PrintOrder, ColorMode, PrintSides, DEFAULT_SHOP_ID } from '@/types/printos';
import { IPrintOSRepository } from '@/lib/repository';
import { WhatsAppOutboxService } from './outbox-service';
import { calculatePrintOrderPrice } from '@/lib/pricing/pricing-engine';
import { parsePageRange } from '@/lib/pricing/page-range';
import { getPaymentProvider } from '@/lib/payment';

export class InvalidTransitionError extends Error {
  constructor(currentState: ConversationState, event: string) {
    super(`Invalid transition from state "${currentState}" with event "${event}".`);
    this.name = 'InvalidTransitionError';
  }
}

export class WhatsAppStateMachine {
  public static readonly CONVERSATION_TTL_MS = 15 * 60 * 1000; // 15 minutes

  /**
   * Helper to resolve the exact WhatsApp chat transport recipient for replies
   * Priority: event.from -> conv.whatsappChatId -> conv.sessionData.whatsappChatId -> conv.customerPhone
   */
  public static getReplyRecipient(
    conv: WhatsAppConversation,
    event?: InboundWhatsAppEvent
  ): string {
    return (
      event?.from ||
      conv.whatsappChatId ||
      conv.sessionData?.whatsappChatId ||
      conv.customerPhone
    );
  }

  /**
   * Process an incoming normalized WhatsApp event for a customer
   */
  public static async processEvent(
    event: InboundWhatsAppEvent,
    repo: IPrintOSRepository,
    shopId = DEFAULT_SHOP_ID
  ): Promise<WhatsAppConversation> {
    const incomingChatId = event.from;
    const now = Date.now();

    // 1. Fetch or initialize conversation
    let conv = await repo.getConversation(incomingChatId, shopId);
    if (!conv) {
      const customerPhone = incomingChatId.endsWith('@c.us')
        ? incomingChatId.slice(0, -5)
        : incomingChatId;

      conv = await repo.upsertConversation({
        customerPhone,
        whatsappChatId: incomingChatId,
        shopId,
        customerName: event.name || null,
        currentState: 'IDLE',
        sessionData: {
          whatsappChatId: incomingChatId,
        },
      });
    } else if (!conv.whatsappChatId || conv.whatsappChatId !== incomingChatId) {
      conv = await repo.upsertConversation({
        id: conv.id,
        customerPhone: conv.customerPhone,
        whatsappChatId: incomingChatId,
        shopId: conv.shopId || shopId,
        sessionData: {
          ...conv.sessionData,
          whatsappChatId: incomingChatId,
        },
      });
    }

    const recipient = this.getReplyRecipient(conv, event);

    // Record incoming message in audit log
    await repo.recordWhatsAppMessage({
      conversationId: conv.id,
      messageId: event.wamid,
      direction: 'INBOUND',
      messageType: event.type,
      body: event.text || event.buttonId || null,
      mediaUrl: event.mediaId || null,
      mediaMimeType: event.mimeType || null,
      rawPayload: event.rawPayload,
    });

    // 2. Check inactivity expiration on configuration draft states
    const lastInteraction = new Date(conv.lastInteractionAt).getTime();
    const isConfigState = [
      'AWAITING_DOCUMENT',
      'DOCUMENT_RECEIVED',
      'COLLECTING_COLOR',
      'COLLECTING_SIDES',
      'COLLECTING_COPIES',
      'COLLECTING_PAGES',
      'CONFIRMING_ORDER',
    ].includes(conv.currentState);

    if (isConfigState && now - lastInteraction > this.CONVERSATION_TTL_MS) {
      conv = await repo.updateConversationState(
        conv.customerPhone,
        'EXPIRED',
        { whatsappChatId: conv.whatsappChatId || incomingChatId },
        null,
        conv.version,
        conv.shopId || shopId
      );
      await WhatsAppOutboxService.queueText(
        repo,
        recipient,
        '⏰ Your previous session has timed out due to inactivity. Send "Hi" or upload a file to start a new print order.',
        conv.id,
        null
      );
      return conv;
    }

    // 3. Global Cancellation and Reset Commands
    const rawText = (event.text || '').toLowerCase().trim();
    const isReset = rawText === 'reset' || rawText === 'clear';
    if (isReset) {
      conv = await repo.updateConversationState(
        conv.customerPhone,
        'IDLE',
        { whatsappChatId: conv.whatsappChatId || incomingChatId },
        null,
        conv.version,
        conv.shopId || shopId
      );
      await WhatsAppOutboxService.queueText(
        repo,
        recipient,
        '🔄 Conversation reset. Send "Hi" or upload a file whenever you would like to start again.',
        conv.id,
        null
      );
      return conv;
    }

    const isCancel =
      event.buttonId === 'btn_cancel' ||
      ['cancel', 'stop', 'quit', 'abort'].includes(rawText);

    if (isCancel && conv.currentState !== 'IDLE' && conv.currentState !== 'ORDER_QUEUED' && conv.currentState !== 'ORDER_PRINTING' && conv.currentState !== 'ORDER_COMPLETED') {
      conv = await repo.updateConversationState(
        conv.customerPhone,
        'CANCELLED',
        { whatsappChatId: conv.whatsappChatId || incomingChatId },
        null,
        conv.version,
        conv.shopId || shopId
      );
      await WhatsAppOutboxService.queueText(
        repo,
        recipient,
        '❌ Order cancelled. Send "Hi" or upload a document whenever you would like to start again.',
        conv.id,
        conv.activeOrderId
      );
      return conv;
    }

    // 4. Handle direct document upload in any initial state
    if (event.type === 'document' || event.type === 'image' || event.filename || (event.text && event.text.endsWith('.pdf'))) {
      return this.handleDocumentUpload(event, conv, repo);
    }

    // 5. State-specific transition handlers
    switch (conv.currentState) {
      case 'IDLE':
      case 'EXPIRED':
      case 'CANCELLED':
      case 'ORDER_COMPLETED':
      case 'ORDER_FAILED':
        return this.handleIdleState(event, conv, repo);

      case 'AWAITING_DOCUMENT':
        return this.handleAwaitingDocument(event, conv, repo);

      case 'DOCUMENT_RECEIVED':
      case 'COLLECTING_COLOR':
        return this.handleCollectingColor(event, conv, repo);

      case 'COLLECTING_SIDES':
        return this.handleCollectingSides(event, conv, repo);

      case 'COLLECTING_COPIES':
        return this.handleCollectingCopies(event, conv, repo);

      case 'COLLECTING_PAGES':
        return this.handleCollectingPages(event, conv, repo);

      case 'CONFIRMING_ORDER':
        return this.handleConfirmingOrder(event, conv, repo);

      case 'AWAITING_PAYMENT':
        return this.handleAwaitingPayment(event, conv, repo);

      case 'ORDER_QUEUED':
      case 'ORDER_PRINTING':
        return this.handleActiveOrder(event, conv, repo);

      default:
        throw new InvalidTransitionError(conv.currentState, event.type);
    }
  }

  // --------------------------------------------------------------------------
  // State Handlers
  // --------------------------------------------------------------------------

  private static async handleIdleState(
    event: InboundWhatsAppEvent,
    conv: WhatsAppConversation,
    repo: IPrintOSRepository
  ): Promise<WhatsAppConversation> {
    const recipient = this.getReplyRecipient(conv, event);
    const updated = await repo.updateConversationState(
      conv.customerPhone,
      'AWAITING_DOCUMENT',
      { whatsappChatId: conv.whatsappChatId || recipient },
      null,
      conv.version,
      conv.shopId || DEFAULT_SHOP_ID
    );

    await WhatsAppOutboxService.queueText(
      repo,
      recipient,
      '👋 Welcome to *PRINTOS*!\n\nPlease send the PDF or image file you would like to print.',
      conv.id,
      null
    );

    return updated;
  }

  private static async handleAwaitingDocument(
    event: InboundWhatsAppEvent,
    conv: WhatsAppConversation,
    repo: IPrintOSRepository
  ): Promise<WhatsAppConversation> {
    const recipient = this.getReplyRecipient(conv, event);
    if (event.type !== 'document' && event.type !== 'image' && !event.filename) {
      await WhatsAppOutboxService.queueText(
        repo,
        recipient,
        '📄 Please attach a document (PDF, PNG, or JPG) to start your print order.',
        conv.id,
        null
      );
      return conv;
    }
    return this.handleDocumentUpload(event, conv, repo);
  }

  public static async handleDocumentUpload(
    event: InboundWhatsAppEvent,
    conv: WhatsAppConversation,
    repo: IPrintOSRepository
  ): Promise<WhatsAppConversation> {
    const recipient = this.getReplyRecipient(conv, event);
    const filename = event.filename || (event.text?.endsWith('.pdf') ? event.text : 'document.pdf');
    const ext = filename.split('.').pop()?.toLowerCase() || 'pdf';

    if (!['pdf', 'jpg', 'jpeg', 'png'].includes(ext)) {
      await WhatsAppOutboxService.queueText(
        repo,
        recipient,
        '⚠️ Unsupported file format. Please send a valid PDF, JPG, or PNG file.',
        conv.id,
        null
      );
      return conv;
    }

    if (event.fileSize && event.fileSize > 50 * 1024 * 1024) {
      await WhatsAppOutboxService.queueText(
        repo,
        recipient,
        '⚠️ File exceeds the 50MB maximum size limit. Please upload a smaller file.',
        conv.id,
        null
      );
      return conv;
    }

    // Default page count: 1 for images, 12 for simulated test documents, or from payload
    const pageCount = (event.rawPayload?.pageCount as number) || (ext === 'pdf' ? 12 : 1);
    const orderId = crypto.randomUUID();
    const storagePath =
      (typeof event.rawPayload?.storagePath === 'string' && event.rawPayload.storagePath.trim()) ||
      (typeof (event as any).storagePath === 'string' && (event as any).storagePath.trim()) ||
      `orders/${orderId}/${filename}`;

    const sessionData: ConversationSessionData = {
      whatsappChatId: conv.whatsappChatId || recipient,
      originalFilename: filename,
      fileType: (event.rawPayload?.fileType as any) || (ext as any),
      fileSize: event.fileSize || 4096,
      pageCount,
      documentPath: storagePath,
      paperSize: 'A4',
    };

    // Transition: DOCUMENT_RECEIVED -> COLLECTING_COLOR
    const updated = await repo.updateConversationState(
      conv.customerPhone,
      'COLLECTING_COLOR',
      sessionData,
      null,
      conv.version,
      conv.shopId || DEFAULT_SHOP_ID
    );

    await WhatsAppOutboxService.queueButtons(
      repo,
      recipient,
      `✅ Received *${filename}* (${pageCount} page${pageCount > 1 ? 's' : ''}).\n\nSelect your print color mode:`,
      [
        { id: 'btn_bw', title: 'Black & White' },
        { id: 'btn_color', title: 'Color' },
      ],
      'PRINTOS Setup',
      'Step 1 of 4',
      conv.id,
      null
    );

    return updated;
  }

  private static async handleCollectingColor(
    event: InboundWhatsAppEvent,
    conv: WhatsAppConversation,
    repo: IPrintOSRepository
  ): Promise<WhatsAppConversation> {
    const recipient = this.getReplyRecipient(conv, event);
    const text = (event.buttonId || event.text || '').toLowerCase().trim();
    let colorMode: ColorMode | null = null;

    if (text === 'btn_bw' || text.includes('bw') || text.includes('black') || text === '1' || text.includes('b&w')) {
      colorMode = 'BW';
    } else if (text === 'btn_color' || text.includes('color') || text.includes('colour') || text === '2') {
      colorMode = 'COLOR';
    }

    if (!colorMode) {
      await WhatsAppOutboxService.queueButtons(
        repo,
        recipient,
        '⚠️ Please select a valid color mode option:',
        [
          { id: 'btn_bw', title: 'Black & White' },
          { id: 'btn_color', title: 'Color' },
        ],
        undefined,
        undefined,
        conv.id,
        null
      );
      return conv;
    }

    const sessionData: ConversationSessionData = {
      ...conv.sessionData,
      whatsappChatId: conv.whatsappChatId || recipient,
      colorMode,
    };

    const updated = await repo.updateConversationState(
      conv.customerPhone,
      'COLLECTING_SIDES',
      sessionData,
      null,
      conv.version,
      conv.shopId || DEFAULT_SHOP_ID
    );

    await WhatsAppOutboxService.queueButtons(
      repo,
      recipient,
      `Color set to *${colorMode === 'BW' ? 'Black & White' : 'Color'}*.\n\nSelect print sides:`,
      [
        { id: 'btn_single', title: 'Single-Sided' },
        { id: 'btn_duplex', title: 'Double-Sided' },
      ],
      'PRINTOS Setup',
      'Step 2 of 4',
      conv.id,
      null
    );

    return updated;
  }

  private static async handleCollectingSides(
    event: InboundWhatsAppEvent,
    conv: WhatsAppConversation,
    repo: IPrintOSRepository
  ): Promise<WhatsAppConversation> {
    const recipient = this.getReplyRecipient(conv, event);
    const text = (event.buttonId || event.text || '').toLowerCase().trim();
    let printSides: PrintSides | null = null;

    if (text === 'btn_single' || text.includes('single') || text === '1' || text.includes('one')) {
      printSides = 'ONE_SIDED';
    } else if (text === 'btn_duplex' || text.includes('double') || text === '2' || text.includes('duplex') || text.includes('both')) {
      printSides = 'BOTH_SIDES';
    }

    if (!printSides) {
      await WhatsAppOutboxService.queueButtons(
        repo,
        recipient,
        '⚠️ Please select a valid print sides option:',
        [
          { id: 'btn_single', title: 'Single-Sided' },
          { id: 'btn_duplex', title: 'Double-Sided' },
        ],
        undefined,
        undefined,
        conv.id,
        null
      );
      return conv;
    }

    const sessionData: ConversationSessionData = {
      ...conv.sessionData,
      whatsappChatId: conv.whatsappChatId || recipient,
      printSides,
    };

    const updated = await repo.updateConversationState(
      conv.customerPhone,
      'COLLECTING_COPIES',
      sessionData,
      null,
      conv.version,
      conv.shopId || DEFAULT_SHOP_ID
    );

    await WhatsAppOutboxService.queueText(
      repo,
      recipient,
      `Sides set to *${printSides === 'ONE_SIDED' ? 'Single-Sided' : 'Double-Sided'}*.\n\nHow many copies do you need? (Enter a number from 1 to 50):`,
      conv.id,
      null
    );

    return updated;
  }

  private static async handleCollectingCopies(
    event: InboundWhatsAppEvent,
    conv: WhatsAppConversation,
    repo: IPrintOSRepository
  ): Promise<WhatsAppConversation> {
    const recipient = this.getReplyRecipient(conv, event);
    const raw = (event.text || '').trim();
    const copies = parseInt(raw, 10);

    if (isNaN(copies) || copies < 1 || copies > 50) {
      await WhatsAppOutboxService.queueText(
        repo,
        recipient,
        '⚠️ Invalid number of copies. Please reply with a number between 1 and 50.',
        conv.id,
        null
      );
      return conv;
    }

    const sessionData: ConversationSessionData = {
      ...conv.sessionData,
      whatsappChatId: conv.whatsappChatId || recipient,
      copies,
    };

    const totalPages = conv.sessionData.pageCount || 1;

    // If single-page document, skip range selection directly to quote confirmation
    if (totalPages === 1) {
      sessionData.pageSelection = 'all';
      sessionData.selectedPageCount = 1;
      return this.generateAndSendQuote(conv, sessionData, repo, event);
    }

    const updated = await repo.updateConversationState(
      conv.customerPhone,
      'COLLECTING_PAGES',
      sessionData,
      null,
      conv.version,
      conv.shopId || DEFAULT_SHOP_ID
    );

    await WhatsAppOutboxService.queueButtons(
      repo,
      recipient,
      `Copies set to *${copies}*.\n\nWhich pages would you like to print? (Document has ${totalPages} pages)\nReply with *"all"* or enter specific pages (e.g. "1-5, 8"):`,
      [{ id: 'btn_all_pages', title: 'All Pages' }],
      'PRINTOS Setup',
      'Step 4 of 4',
      conv.id,
      null
    );

    return updated;
  }

  private static async handleCollectingPages(
    event: InboundWhatsAppEvent,
    conv: WhatsAppConversation,
    repo: IPrintOSRepository
  ): Promise<WhatsAppConversation> {
    const recipient = this.getReplyRecipient(conv, event);
    const raw = (event.buttonId || event.text || '').trim();
    const totalPages = conv.sessionData.pageCount || 1;

    let pageSelection = 'all';
    let selectedCount = totalPages;

    if (raw !== 'btn_all_pages' && raw.toLowerCase() !== 'all') {
      try {
        const parsed = parsePageRange(raw, totalPages);
        selectedCount = parsed.count;
        pageSelection = raw;
      } catch (err: unknown) {
        await WhatsAppOutboxService.queueText(
          repo,
          recipient,
          `⚠️ Invalid page range: ${err instanceof Error ? err.message : 'Invalid syntax'}. Reply with "all" or valid ranges like "1-3, 5".`,
          conv.id,
          null
        );
        return conv;
      }
    }

    const sessionData: ConversationSessionData = {
      ...conv.sessionData,
      whatsappChatId: conv.whatsappChatId || recipient,
      pageSelection,
      selectedPageCount: selectedCount,
    };

    return this.generateAndSendQuote(conv, sessionData, repo, event);
  }

  private static async generateAndSendQuote(
    conv: WhatsAppConversation,
    sessionData: ConversationSessionData,
    repo: IPrintOSRepository,
    event?: InboundWhatsAppEvent
  ): Promise<WhatsAppConversation> {
    const recipient = this.getReplyRecipient(conv, event);
    const pricing = calculatePrintOrderPrice({
      paperSize: sessionData.paperSize || 'A4',
      colorMode: sessionData.colorMode || 'BW',
      printSides: sessionData.printSides || 'ONE_SIDED',
      copies: sessionData.copies || 1,
      totalDocumentPages: sessionData.pageCount || 1,
      pageSelection: sessionData.pageSelection || 'all',
    });

    sessionData.subtotalPaisa = pricing.subtotalPaisa;
    sessionData.discountPaisa = pricing.discountPaisa;
    sessionData.totalAmountPaisa = pricing.totalAmountPaisa;
    sessionData.whatsappChatId = conv.whatsappChatId || recipient;

    const updated = await repo.updateConversationState(
      conv.customerPhone,
      'CONFIRMING_ORDER',
      sessionData,
      null,
      conv.version,
      conv.shopId || DEFAULT_SHOP_ID
    );

    const priceRupees = (pricing.totalAmountPaisa / 100).toFixed(2);
    const summary =
      `📋 *Order Summary:*\n` +
      `• File: *${sessionData.originalFilename}*\n` +
      `• Pages: *${sessionData.selectedPageCount}* (${sessionData.pageSelection || 'all'})\n` +
      `• Mode: *${sessionData.colorMode === 'BW' ? 'B&W' : 'Color'}* | *${sessionData.printSides === 'ONE_SIDED' ? '1-Sided' : '2-Sided'}*\n` +
      `• Copies: *${sessionData.copies}*\n` +
      `• *Total Price: ₹${priceRupees}*\n\n` +
      `Please confirm your order to proceed to payment:`;

    await WhatsAppOutboxService.queueButtons(
      repo,
      recipient,
      summary,
      [
        { id: 'btn_confirm', title: 'Confirm & Pay' },
        { id: 'btn_cancel', title: 'Cancel' },
      ],
      'PRINTOS Quote',
      undefined,
      conv.id,
      null
    );

    return updated;
  }

  private static async handleConfirmingOrder(
    event: InboundWhatsAppEvent,
    conv: WhatsAppConversation,
    repo: IPrintOSRepository
  ): Promise<WhatsAppConversation> {
    const recipient = this.getReplyRecipient(conv, event);
    const text = (event.buttonId || event.text || '').toLowerCase().trim();

    if (text === 'btn_confirm' || text.includes('confirm') || text.includes('pay') || text === 'yes' || text === '1') {
      const s = {
        ...conv.sessionData,
        whatsappChatId: conv.whatsappChatId || recipient,
      };
      const orderId = crypto.randomUUID();
      const orderNumber = `P${Math.floor(10000 + Math.random() * 90000)}`;

      const order: PrintOrder = {
        id: orderId,
        shopId: conv.shopId || DEFAULT_SHOP_ID,
        orderNumber,
        customerPhone: conv.customerPhone,
        customerName: conv.customerName,
        status: 'AWAITING_PAYMENT',
        originalFilename: s.originalFilename || 'document.pdf',
        storagePath: s.documentPath || `orders/${orderId}/${s.originalFilename || 'document.pdf'}`,
        fileType: s.fileType || 'pdf',
        fileSize: s.fileSize || 4096,
        pageCount: s.pageCount || 1,
        paperSize: s.paperSize || 'A4',
        colorMode: s.colorMode || 'BW',
        printSides: s.printSides || 'ONE_SIDED',
        copies: s.copies || 1,
        pageSelection: s.pageSelection || 'all',
        selectedPageCount: s.selectedPageCount || 1,
        subtotalPaisa: s.subtotalPaisa || 0,
        discountPaisa: s.discountPaisa || 0,
        totalAmountPaisa: s.totalAmountPaisa || 0,
        currency: 'INR',
        paymentStatus: 'PENDING',
        createdAt: new Date().toISOString(),
      };

      await repo.createOrder(order);

      const updated = await repo.updateConversationState(
        conv.customerPhone,
        'AWAITING_PAYMENT',
        s,
        orderId,
        conv.version,
        conv.shopId || DEFAULT_SHOP_ID
      );

      const paymentProvider = getPaymentProvider();
      const paymentIntent = await paymentProvider.createPaymentIntent({
        orderId,
        orderNumber,
        amountPaisa: s.totalAmountPaisa || 0,
        customerPhone: conv.customerPhone,
        customerName: conv.customerName,
      });

      const amountRupees = ((s.totalAmountPaisa || 0) / 100).toFixed(2);
      const upiLink = paymentIntent.upiIntentUrl || `upi://pay?pa=printos@upi&pn=PRINTOS&am=${amountRupees}&cu=INR&tr=${orderNumber}`;
      const checkoutLink = paymentIntent.paymentUrl ? `\n💳 *Online Checkout:* ${paymentIntent.paymentUrl}\n` : '';

      await WhatsAppOutboxService.queueText(
        repo,
        recipient,
        `💳 *Payment Required: ₹${amountRupees}*\n\n` +
        `Order *#${orderNumber}* created.\n` +
        `Pay using UPI to immediately queue your print job:\n\n` +
        `👉 *UPI Pay Link:* ${upiLink}\n` +
        checkoutLink + `\n` +
        `_Printing starts automatically once payment is verified._`,
        conv.id,
        orderId
      );

      return updated;
    }

    await WhatsAppOutboxService.queueButtons(
      repo,
      recipient,
      '⚠️ Please confirm your order to generate the payment link:',
      [
        { id: 'btn_confirm', title: 'Confirm & Pay' },
        { id: 'btn_cancel', title: 'Cancel' },
      ],
      undefined,
      undefined,
      conv.id,
      null
    );

    return conv;
  }

  private static async handleAwaitingPayment(
    event: InboundWhatsAppEvent,
    conv: WhatsAppConversation,
    repo: IPrintOSRepository
  ): Promise<WhatsAppConversation> {
    const recipient = this.getReplyRecipient(conv, event);
    const amountRupees = (((conv.sessionData.totalAmountPaisa || 0) / 100)).toFixed(2);
    await WhatsAppOutboxService.queueText(
      repo,
      recipient,
      `⏳ Your order is awaiting payment of *₹${amountRupees}*.\n\nPrinting will begin automatically as soon as payment is completed.`,
      conv.id,
      conv.activeOrderId
    );
    return conv;
  }

  private static async handleActiveOrder(
    event: InboundWhatsAppEvent,
    conv: WhatsAppConversation,
    repo: IPrintOSRepository
  ): Promise<WhatsAppConversation> {
    const recipient = this.getReplyRecipient(conv, event);
    if (conv.activeOrderId) {
      const order = await repo.getOrder(conv.activeOrderId);
      if (order) {
        await WhatsAppOutboxService.queueText(
          repo,
          recipient,
          `ℹ️ Your Order *#${order.orderNumber}* status is: *${order.status}*.\nWe will notify you the moment it is ready for collection!`,
          conv.id,
          conv.activeOrderId
        );
        return conv;
      }
    }
    return this.handleIdleState(event, conv, repo);
  }
}
