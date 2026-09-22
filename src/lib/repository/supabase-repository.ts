import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import {
  Shop,
  DEFAULT_SHOP_ID,
  PrintOrder,
  PrintJob,
  PrintOrderEvent,
  Printer,
  PrintAgent,
  ClaimedJob,
  AgentJobStatusUpdate,
  OrderStatus,
  JobStatus,
  PrinterStatus,
} from '@/types/printos';
import {
  ConversationState,
  ConversationSessionData,
  WhatsAppConversation,
  WhatsAppInboxItem,
  WhatsAppOutboxItem,
  WhatsAppOutboxPayload,
  WhatsAppMessage,
  OutboxMessageType,
} from '@/types/whatsapp';
import { OrderStateMachine } from '@/lib/orders/state-machine';
import {
  IPrintOSRepository,
  DashboardMetrics,
  UnauthorizedAgentJobError,
  ResourceNotFoundError,
  StaleConversationVersionError,
} from './repository.interface';
import { getStorageBucket } from '@/lib/storage/storage-service';
import { isSameDayInTimezone, getShopTimezone, getTodayTimeRangeUtc, DEFAULT_SHOP_TIMEZONE } from '@/lib/utils/timezone-utils';

export class SupabasePrintOSRepository implements IPrintOSRepository {
  private supabase: SupabaseClient;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  // --------------------------------------------------------------------------
  // Shop Tenant Management
  // --------------------------------------------------------------------------
  public async getShop(shopId: string): Promise<Shop | null> {
    const { data, error } = await this.supabase
      .from('shops')
      .select('*')
      .eq('id', shopId)
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase getShop failed: ${error.message}`);
    }
    return data ? this.mapShop(data) : null;
  }

  public async listShops(): Promise<Shop[]> {
    const { data, error } = await this.supabase
      .from('shops')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Supabase listShops failed: ${error.message}`);
    }
    return (data || []).map((row) => this.mapShop(row));
  }

  public async createShop(shop: Shop): Promise<Shop> {
    const { data, error } = await this.supabase
      .from('shops')
      .insert({
        id: shop.id,
        name: shop.name,
        slug: shop.slug,
        phone: shop.phone || null,
        address: shop.address || null,
        currency: shop.currency || 'INR',
        is_active: shop.isActive ?? true,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Supabase createShop failed: ${error.message}`);
    }
    return this.mapShop(data);
  }

  public async updateShop(shopId: string, updates: Partial<Shop>): Promise<Shop> {
    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (updates.name !== undefined) payload.name = updates.name;
    if (updates.slug !== undefined) payload.slug = updates.slug;
    if (updates.phone !== undefined) payload.phone = updates.phone;
    if (updates.address !== undefined) payload.address = updates.address;
    if (updates.currency !== undefined) payload.currency = updates.currency;
    if (updates.isActive !== undefined) payload.is_active = updates.isActive;

    const { data, error } = await this.supabase
      .from('shops')
      .update(payload)
      .eq('id', shopId)
      .select()
      .single();

    if (error) {
      throw new Error(`Supabase updateShop failed: ${error.message}`);
    }
    return this.mapShop(data);
  }

  // --------------------------------------------------------------------------
  // Order Operations
  // --------------------------------------------------------------------------
  public async createOrder(order: PrintOrder): Promise<PrintOrder> {
    const { data, error } = await this.supabase
      .from('print_orders')
      .insert({
        id: order.id,
        shop_id: order.shopId || DEFAULT_SHOP_ID,
        order_number: order.orderNumber,
        customer_phone: order.customerPhone,
        customer_name: order.customerName || null,
        status: order.status,
        original_filename: order.originalFilename,
        storage_path: order.storagePath,
        file_type: order.fileType,
        file_size: order.fileSize,
        page_count: order.pageCount,
        paper_size: order.paperSize,
        color_mode: order.colorMode,
        print_sides: order.printSides,
        copies: order.copies,
        page_selection: order.pageSelection || null,
        selected_page_count: order.selectedPageCount,
        subtotal_paisa: order.subtotalPaisa,
        discount_paisa: order.discountPaisa,
        total_amount_paisa: order.totalAmountPaisa,
        currency: order.currency,
        payment_status: order.paymentStatus,
        printer_id: order.printerId || null,
        created_at: order.createdAt,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Supabase createOrder failed: ${error.message}`);
    }

    await this.recordOrderEvent(order.id, 'FILE_RECEIVED', 'Order created and file registered', {
      filename: order.originalFilename,
      fileSize: order.fileSize,
      pageCount: order.pageCount,
      shopId: order.shopId || DEFAULT_SHOP_ID,
    });

    return this.mapOrder(data);
  }

  public async getOrder(id: string): Promise<PrintOrder | null> {
    const { data, error } = await this.supabase
      .from('print_orders')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase getOrder failed: ${error.message}`);
    }
    return data ? this.mapOrder(data) : null;
  }

  public async getOrderByNumber(orderNumber: string): Promise<PrintOrder | null> {
    const { data, error } = await this.supabase
      .from('print_orders')
      .select('*')
      .eq('order_number', orderNumber)
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase getOrderByNumber failed: ${error.message}`);
    }
    return data ? this.mapOrder(data) : null;
  }

  public async listOrders(filters?: { status?: OrderStatus; limit?: number; shopId?: string; todayOnly?: boolean }): Promise<PrintOrder[]> {
    let query = this.supabase
      .from('print_orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (filters?.shopId) {
      query = query.eq('shop_id', filters.shopId);
    }
    if (filters?.status) {
      query = query.eq('status', filters.status);
    }
    if (filters?.todayOnly) {
      const shop = filters.shopId ? await this.getShop(filters.shopId) : null;
      const tz = getShopTimezone(shop);
      const { startIso, endIso } = getTodayTimeRangeUtc(tz);
      query = query.gte('created_at', startIso).lt('created_at', endIso);
    }
    if (filters?.limit) {
      query = query.limit(filters.limit);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Supabase listOrders failed: ${error.message}`);
    }
    return (data || []).map((row) => this.mapOrder(row));
  }

  public async updateOrderStatus(
    orderId: string,
    nextStatus: OrderStatus,
    metadata?: Record<string, unknown>
  ): Promise<PrintOrder> {
    const existing = await this.getOrder(orderId);
    if (!existing) {
      throw new ResourceNotFoundError('Order', orderId);
    }

    OrderStateMachine.validateTransition(existing.status, nextStatus);

    const prevStatus = existing.status;
    const now = new Date().toISOString();
    const updatePayload: Record<string, unknown> = { status: nextStatus };

    if (nextStatus === 'PAID') updatePayload.paid_at = now;
    if (nextStatus === 'QUEUED') updatePayload.queued_at = now;
    if (nextStatus === 'PRINTING') updatePayload.started_at = now;
    if (nextStatus === 'COMPLETED') updatePayload.completed_at = now;
    if (nextStatus === 'FAILED' || nextStatus === 'CANCELLED') updatePayload.failed_at = now;

    const { data, error } = await this.supabase
      .from('print_orders')
      .update(updatePayload)
      .eq('id', orderId)
      .select()
      .single();

    if (error) {
      throw new Error(`Supabase updateOrderStatus failed: ${error.message}`);
    }

    await this.recordOrderEvent(
      orderId,
      `STATUS_${nextStatus}`,
      `Order status transitioned from ${prevStatus} to ${nextStatus}`,
      metadata
    );

    return this.mapOrder(data);
  }

  // --------------------------------------------------------------------------
  // Audit Events
  // --------------------------------------------------------------------------
  public async recordOrderEvent(
    orderId: string,
    eventType: string,
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<PrintOrderEvent> {
    const { data, error } = await this.supabase
      .from('print_order_events')
      .insert({
        order_id: orderId,
        event_type: eventType,
        message,
        metadata: metadata || {},
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Supabase recordOrderEvent failed: ${error.message}`);
    }

    return {
      id: data.id,
      orderId: data.order_id,
      eventType: data.event_type,
      message: data.message,
      metadata: data.metadata || {},
      createdAt: data.created_at,
    };
  }

  public async getOrderEvents(orderId: string): Promise<PrintOrderEvent[]> {
    const { data, error } = await this.supabase
      .from('print_order_events')
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Supabase getOrderEvents failed: ${error.message}`);
    }

    return (data || []).map((row) => ({
      id: row.id,
      orderId: row.order_id,
      eventType: row.event_type,
      message: row.message,
      metadata: row.metadata || {},
      createdAt: row.created_at,
    }));
  }

  // --------------------------------------------------------------------------
  // Payment & Idempotency
  // --------------------------------------------------------------------------
  public async simulateVerifiedPayment(
    orderId: string,
    transactionId: string,
    provider = 'UPI_QR',
    amountPaisa?: number
  ): Promise<{ order: PrintOrder; job: PrintJob; isDuplicate: boolean }> {
    const order = await this.getOrder(orderId);
    if (!order) {
      throw new ResourceNotFoundError('Order', orderId);
    }

    if (amountPaisa !== undefined && amountPaisa !== order.totalAmountPaisa) {
      throw new Error(
        `Payment amount mismatch: expected ${order.totalAmountPaisa} paisa, received ${amountPaisa} paisa`
      );
    }

    const { data, error } = await this.supabase.rpc('process_verified_payment', {
      p_order_id: orderId,
      p_transaction_id: transactionId,
      p_provider: provider,
      p_amount_paisa: amountPaisa ?? order.totalAmountPaisa,
    });
    if (error || !data?.[0]?.job_id) {
      throw new Error(`Supabase payment transaction failed: ${error?.message || 'payment RPC returned no job'}`);
    }

    const [updatedOrder, job] = await Promise.all([this.getOrder(orderId), this.getJob(data[0].job_id)]);
    if (!updatedOrder || !job) {
      throw new Error('Payment transaction committed without a retrievable order and job.');
    }
    return { order: updatedOrder, job, isDuplicate: Boolean(data[0].is_duplicate) };
  }

  public async getJob(id: string): Promise<PrintJob | null> {
    const { data, error } = await this.supabase
      .from('print_jobs')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase getJob failed: ${error.message}`);
    }
    return data ? this.mapJob(data) : null;
  }

  public async getJobByOrderId(orderId: string): Promise<PrintJob | null> {
    const { data, error } = await this.supabase
      .from('print_jobs')
      .select('*')
      .eq('order_id', orderId)
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase getJobByOrderId failed: ${error.message}`);
    }
    return data ? this.mapJob(data) : null;
  }

  public async listJobs(filters?: { status?: JobStatus; limit?: number; shopId?: string }): Promise<PrintJob[]> {
    let query = this.supabase
      .from('print_jobs')
      .select('*')
      .order('created_at', { ascending: false });

    if (filters?.shopId) {
      query = query.eq('shop_id', filters.shopId);
    }
    if (filters?.status) {
      query = query.eq('status', filters.status);
    }
    if (filters?.limit) {
      query = query.limit(filters.limit);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Supabase listJobs failed: ${error.message}`);
    }
    return (data || []).map((row) => this.mapJob(row));
  }

  /**
   * Atomic queue claiming via PostgreSQL RPC using FOR UPDATE SKIP LOCKED
   */
  public async claimNextPrintJob(agentId: string, printerId?: string, shopId?: string): Promise<ClaimedJob | null> {
    const { data, error } = await this.supabase.rpc('claim_next_print_job', {
      p_agent_id: agentId,
      p_printer_id: printerId || null,
      p_shop_id: shopId || null,
    });

    if (error) {
      throw new Error(`Supabase RPC claim_next_print_job failed: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return null;
    }

    const row = data[0];
    return {
      jobId: row.job_id,
      orderId: row.order_id,
      orderNumber: row.order_number,
      storagePath: row.storage_path,
      originalFilename: row.original_filename,
      printOptions: row.print_options,
      copies: row.copies,
      paperSize: row.paper_size,
      colorMode: row.color_mode,
      printSides: row.print_sides,
      pageSelection: row.page_selection,
      downloadUrl: `/api/agent/jobs/${row.job_id}/document`,
    };
  }

  public async updateJobStatus(
    jobId: string,
    agentId: string,
    update: AgentJobStatusUpdate
  ): Promise<PrintJob> {
    const job = await this.getJob(jobId);
    if (!job) {
      throw new ResourceNotFoundError('Job', jobId);
    }

    if (job.agentId !== agentId) {
      throw new UnauthorizedAgentJobError(agentId, jobId);
    }

    const now = new Date().toISOString();
    const updatePayload: Record<string, unknown> = {};

    if (update.status === 'PRINTING') {
      updatePayload.status = 'PRINTING';
      updatePayload.started_at = now;
      await this.updateOrderStatus(job.orderId, 'PRINTING');
    } else if (update.status === 'COMPLETED') {
      updatePayload.status = 'COMPLETED';
      updatePayload.completed_at = now;
      await this.updateOrderStatus(job.orderId, 'COMPLETED', { completedAt: now });
    } else if (update.status === 'FAILED') {
      const errorMsg = update.errorMessage || 'Print failed';
      updatePayload.error_message = errorMsg;
      if (job.attemptCount < job.maxAttempts) {
        updatePayload.status = 'RETRY_PENDING';
        await this.recordOrderEvent(
          job.orderId,
          'PRINT_RETRY_SCHEDULED',
          `Print attempt ${job.attemptCount} failed: ${errorMsg}. Re-queued for retry.`
        );
      } else {
        updatePayload.status = 'FAILED';
        updatePayload.failed_at = now;
        await this.updateOrderStatus(job.orderId, 'FAILED', { errorMessage: errorMsg });
      }
    }

    const { data, error } = await this.supabase
      .from('print_jobs')
      .update(updatePayload)
      .eq('id', jobId)
      .select()
      .single();

    if (error) {
      throw new Error(`Supabase updateJobStatus failed: ${error.message}`);
    }

    return this.mapJob(data);
  }

  public async authenticateAgent(providedKey: string): Promise<PrintAgent | null> {
    const hash = crypto.createHash('sha256').update(providedKey).digest('hex');

    const { data, error } = await this.supabase
      .from('print_agents')
      .select('*')
      .eq('api_key_hash', hash)
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase authenticateAgent failed: ${error.message}`);
    }

    return data ? this.mapAgent(data) : null;
  }

  public async recordAgentHeartbeat(
    agentId: string,
    printerStatus: PrinterStatus,
    capabilities?: Record<string, unknown>,
    version = '1.0.0'
  ): Promise<PrintAgent> {
    const now = new Date().toISOString();

    const { data, error } = await this.supabase
      .from('print_agents')
      .update({
        status: 'ONLINE',
        version,
        capabilities: capabilities || {},
        last_seen_at: now,
      })
      .eq('id', agentId)
      .select()
      .single();

    if (error) {
      throw new Error(`Supabase recordAgentHeartbeat failed: ${error.message}`);
    }

    await this.supabase
      .from('printers')
      .update({ status: printerStatus, last_seen_at: now })
      .eq('shop_id', data.shop_id);

    return this.mapAgent(data);
  }

  public async listPrinters(filters?: { shopId?: string }): Promise<Printer[]> {
    let query = this.supabase.from('printers').select('*');
    if (filters?.shopId) {
      query = query.eq('shop_id', filters.shopId);
    }
    const { data, error } = await query;
    if (error) {
      throw new Error(`Supabase listPrinters failed: ${error.message}`);
    }

    const now = Date.now();
    return (data || []).map((row) => {
      const isOffline = row.last_seen_at && now - new Date(row.last_seen_at).getTime() > 60000;
      return {
        id: row.id,
        shopId: row.shop_id,
        name: row.name,
        location: row.location,
        status: (isOffline ? 'OFFLINE' : row.status) as PrinterStatus,
        isActive: row.is_active,
        supportsColor: row.supports_color,
        supportsDuplex: row.supports_duplex,
        supportedPaperSizes: row.supported_paper_sizes,
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at,
      };
    });
  }

  public async getDashboardMetrics(shopId?: string): Promise<DashboardMetrics> {
    const targetShopId = shopId || DEFAULT_SHOP_ID;
    const shop = await this.getShop(targetShopId);
    const tz = getShopTimezone(shop);
    const now = new Date();

    const orders = await this.listOrders({ shopId: targetShopId });

    // Active work
    const queuedCount = orders.filter((o) => o.status === 'QUEUED').length;
    const printingCount = orders.filter((o) => o.status === 'PRINTING').length;

    // Today's created orders
    const todayCreatedOrders = orders.filter((o) => isSameDayInTimezone(o.createdAt, now, tz));

    // Today's completed orders (evaluated based on completion timestamp when available, fallback to createdAt)
    const todayCompletedOrders = orders.filter(
      (o) => o.status === 'COMPLETED' && isSameDayInTimezone(o.completedAt || o.createdAt, now, tz)
    );

    // Today's failed orders
    const todayFailedOrders = orders.filter(
      (o) => o.status === 'FAILED' && isSameDayInTimezone(o.failedAt || o.createdAt, now, tz)
    );

    // Revenue: sum total_amount_paisa ONLY for today's COMPLETED orders
    const totalRevenuePaisa = todayCompletedOrders.reduce((sum, o) => sum + o.totalAmountPaisa, 0);

    // Pages printed: sum selectedPageCount * copies for today's COMPLETED orders
    const totalPagesPrinted = todayCompletedOrders.reduce((sum, o) => sum + o.selectedPageCount * o.copies, 0);

    return {
      todayOrders: todayCreatedOrders.length,
      queued: queuedCount,
      printing: printingCount,
      completed: todayCompletedOrders.length,
      failed: todayFailedOrders.length,
      revenuePaisa: totalRevenuePaisa,
      pagesPrinted: totalPagesPrinted,
    };
  }

  // --------------------------------------------------------------------------
  // Phase 2: WhatsApp Conversations & Locking
  // --------------------------------------------------------------------------
  public async getConversation(identifier: string, shopId?: string): Promise<WhatsAppConversation | null> {
    const tenantShopId = shopId || DEFAULT_SHOP_ID;

    // 1. Exact prioritized match on whatsapp_chat_id
    if (identifier.includes('@')) {
      let queryChatId = this.supabase
        .from('whatsapp_conversations')
        .select('*')
        .eq('whatsapp_chat_id', identifier);

      if (shopId) {
        queryChatId = queryChatId.eq('shop_id', tenantShopId);
      }

      const { data, error } = await queryChatId.maybeSingle();
      if (error) {
        throw new Error(`Supabase getConversation by whatsapp_chat_id failed: ${error.message}`);
      }
      if (data) {
        return this.mapConversation(data);
      }
    }

    // 2. Exact match on customer_phone
    let queryPhone = this.supabase
      .from('whatsapp_conversations')
      .select('*')
      .eq('customer_phone', identifier);

    if (shopId) {
      queryPhone = queryPhone.eq('shop_id', tenantShopId);
    }

    const { data: phoneData, error: phoneErr } = await queryPhone.maybeSingle();
    if (phoneErr) {
      throw new Error(`Supabase getConversation by customer_phone failed: ${phoneErr.message}`);
    }
    if (phoneData) {
      // If found and the identifier was an explicit WhatsApp JID, backfill whatsapp_chat_id if null
      if (identifier.includes('@') && !phoneData.whatsapp_chat_id) {
        await this.supabase
          .from('whatsapp_conversations')
          .update({ whatsapp_chat_id: identifier })
          .eq('id', phoneData.id);
        phoneData.whatsapp_chat_id = identifier;
      }
      return this.mapConversation(phoneData);
    }

    // 3. Safe fallback ONLY for standard user @c.us domain (where user digits == phone number)
    if (identifier.endsWith('@c.us')) {
      const phoneDigits = identifier.slice(0, -5);
      let queryCus = this.supabase
        .from('whatsapp_conversations')
        .select('*')
        .eq('customer_phone', phoneDigits);

      if (shopId) {
        queryCus = queryCus.eq('shop_id', tenantShopId);
      }

      const { data: cusData, error: cusErr } = await queryCus.maybeSingle();
      if (cusErr) {
        throw new Error(`Supabase getConversation by @c.us digits failed: ${cusErr.message}`);
      }
      if (cusData) {
        if (!cusData.whatsapp_chat_id) {
          await this.supabase
            .from('whatsapp_conversations')
            .update({ whatsapp_chat_id: identifier })
            .eq('id', cusData.id);
          cusData.whatsapp_chat_id = identifier;
        }
        return this.mapConversation(cusData);
      }
    }

    // 4. Safe fallback from plain numeric phone to @c.us chat ID
    if (!identifier.includes('@')) {
      const cusChatId = `${identifier}@c.us`;
      let queryByCusChat = this.supabase
        .from('whatsapp_conversations')
        .select('*')
        .eq('whatsapp_chat_id', cusChatId);

      if (shopId) {
        queryByCusChat = queryByCusChat.eq('shop_id', tenantShopId);
      }

      const { data: chatData, error: chatErr } = await queryByCusChat.maybeSingle();
      if (chatErr) {
        throw new Error(`Supabase getConversation by phone @c.us chat ID failed: ${chatErr.message}`);
      }
      if (chatData) {
        return this.mapConversation(chatData);
      }
    }

    return null;
  }

  public async upsertConversation(
    conversation: Partial<WhatsAppConversation> & { customerPhone: string; whatsappChatId?: string | null; shopId?: string | null }
  ): Promise<WhatsAppConversation> {
    const identifier = conversation.whatsappChatId || conversation.customerPhone;
    const existing = await this.getConversation(identifier, conversation.shopId || undefined);
    const now = new Date().toISOString();
    const resolvedChatId = conversation.whatsappChatId || existing?.whatsappChatId || (conversation.customerPhone.includes('@') ? conversation.customerPhone : null);

    if (existing) {
      const { data, error } = await this.supabase
        .from('whatsapp_conversations')
        .update({
          shop_id: conversation.shopId || existing.shopId || DEFAULT_SHOP_ID,
          whatsapp_chat_id: resolvedChatId || existing.whatsappChatId || null,
          customer_name: conversation.customerName !== undefined ? conversation.customerName : existing.customerName,
          current_state: conversation.currentState || existing.currentState,
          active_order_id: conversation.activeOrderId !== undefined ? conversation.activeOrderId : existing.activeOrderId,
          session_data: {
            ...existing.sessionData,
            ...(conversation.sessionData || {}),
            ...(resolvedChatId ? { whatsappChatId: resolvedChatId } : {}),
          },
          version: existing.version + 1,
          last_interaction_at: now,
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (error) {
        throw new Error(`Supabase upsertConversation update failed: ${error.message}`);
      }
      return this.mapConversation(data);
    }

    const { data, error } = await this.supabase
      .from('whatsapp_conversations')
      .insert({
        id: conversation.id || crypto.randomUUID(),
        shop_id: conversation.shopId || DEFAULT_SHOP_ID,
        customer_phone: conversation.customerPhone,
        whatsapp_chat_id: resolvedChatId || null,
        customer_name: conversation.customerName || null,
        current_state: conversation.currentState || 'IDLE',
        active_order_id: conversation.activeOrderId || null,
        session_data: {
          ...(conversation.sessionData || {}),
          ...(resolvedChatId ? { whatsappChatId: resolvedChatId } : {}),
        },
        version: 1,
        last_interaction_at: now,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Supabase upsertConversation insert failed: ${error.message}`);
    }
    return this.mapConversation(data);
  }

  public async updateConversationState(
    identifier: string,
    nextState: ConversationState,
    sessionData?: ConversationSessionData,
    activeOrderId?: string | null,
    expectedVersion?: number,
    shopId?: string
  ): Promise<WhatsAppConversation> {
    const existing = await this.getConversation(identifier, shopId);
    if (!existing) {
      throw new ResourceNotFoundError('Conversation', identifier);
    }

    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new StaleConversationVersionError(identifier, expectedVersion);
    }

    const mergedSessionData: ConversationSessionData = {
      ...existing.sessionData,
      ...(sessionData !== undefined ? sessionData : {}),
    };
    if (existing.whatsappChatId && !mergedSessionData.whatsappChatId) {
      mergedSessionData.whatsappChatId = existing.whatsappChatId;
    }

    let query = this.supabase
      .from('whatsapp_conversations')
      .update({
        current_state: nextState,
        session_data: mergedSessionData,
        whatsapp_chat_id: existing.whatsappChatId || null,
        active_order_id: activeOrderId !== undefined ? activeOrderId : existing.activeOrderId,
        version: existing.version + 1,
        last_interaction_at: new Date().toISOString(),
      })
      .eq('id', existing.id);

    if (shopId) {
      query = query.eq('shop_id', shopId);
    }

    if (expectedVersion !== undefined) {
      query = query.eq('version', expectedVersion);
    }

    const { data, error } = await query.select().single();
    if (error) {
      if (expectedVersion !== undefined) {
        throw new StaleConversationVersionError(identifier, expectedVersion);
      }
      throw new Error(`Supabase updateConversationState failed: ${error.message}`);
    }

    return this.mapConversation(data);
  }

  // --------------------------------------------------------------------------
  // Phase 2: WhatsApp Inbox Operations
  // --------------------------------------------------------------------------
  public async enqueueInboxItem(item: {
    messageId: string;
    senderPhone: string;
    rawPayload: Record<string, unknown>;
    shopId?: string;
  }): Promise<{ item: WhatsAppInboxItem; isDuplicate: boolean }> {
    const { data, error } = await this.supabase
      .from('whatsapp_inbox')
      .insert({
        shop_id: item.shopId || DEFAULT_SHOP_ID,
        message_id: item.messageId,
        sender_phone: item.senderPhone,
        raw_payload: item.rawPayload,
        status: 'RECEIVED',
        attempt_count: 0,
        max_attempts: 5,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        const { data: existing } = await this.supabase
          .from('whatsapp_inbox')
          .select('*')
          .eq('message_id', item.messageId)
          .single();
        if (existing) {
          return { item: this.mapInboxItem(existing), isDuplicate: true };
        }
      }
      throw new Error(`Supabase enqueueInboxItem failed: ${error.message}`);
    }

    return { item: this.mapInboxItem(data), isDuplicate: false };
  }

  public async claimInboxBatch(
    workerId: string,
    limit = 10,
    leaseSeconds = 120
  ): Promise<WhatsAppInboxItem[]> {
    const nowIso = new Date().toISOString();
    const lockedUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();

    const { data: eligible, error: fetchError } = await this.supabase
      .from('whatsapp_inbox')
      .select('*')
      .or(`status.in.(RECEIVED,RETRYABLE),and(status.eq.PROCESSING,locked_until.lt.${nowIso})`)
      .order('received_at', { ascending: true })
      .limit(limit);

    if (fetchError || !eligible || eligible.length === 0) {
      return [];
    }

    const claimed: WhatsAppInboxItem[] = [];
    for (const row of eligible) {
      const { data: updated, error: updateError } = await this.supabase
        .from('whatsapp_inbox')
        .update({
          status: 'PROCESSING',
          worker_id: workerId,
          processing_started_at: nowIso,
          locked_until: lockedUntil,
        })
        .eq('id', row.id)
        .select()
        .single();

      if (!updateError && updated) {
        claimed.push(this.mapInboxItem(updated));
      }
    }

    return claimed;
  }

  public async renewInboxLease(id: string, workerId: string, additionalSeconds = 120): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const lockedUntil = new Date(Date.now() + additionalSeconds * 1000).toISOString();

    const { data, error } = await this.supabase
      .from('whatsapp_inbox')
      .update({ locked_until: lockedUntil })
      .eq('id', id)
      .eq('worker_id', workerId)
      .gte('locked_until', nowIso)
      .select();

    return !error && data && data.length > 0;
  }

  public async completeInboxItem(id: string, workerId: string): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('whatsapp_inbox')
      .update({
        status: 'PROCESSED',
        processed_at: nowIso,
        locked_until: null,
      })
      .eq('id', id)
      .eq('worker_id', workerId)
      .select();

    return !error && data && data.length > 0;
  }

  public async failInboxItem(
    id: string,
    workerId: string,
    errorMsg: string,
    retryable = true
  ): Promise<boolean> {
    const { data: current } = await this.supabase
      .from('whatsapp_inbox')
      .select('attempt_count, max_attempts')
      .eq('id', id)
      .eq('worker_id', workerId)
      .single();

    if (!current) return false;

    const nextAttempt = current.attempt_count + 1;
    const nextStatus = !retryable || nextAttempt >= current.max_attempts ? 'DEAD_LETTER' : 'RETRYABLE';

    const { data, error } = await this.supabase
      .from('whatsapp_inbox')
      .update({
        status: nextStatus,
        attempt_count: nextAttempt,
        last_error: errorMsg,
        locked_until: null,
      })
      .eq('id', id)
      .eq('worker_id', workerId)
      .select();

    return !error && data && data.length > 0;
  }

  // --------------------------------------------------------------------------
  // Phase 2: WhatsApp Outbox Operations
  // --------------------------------------------------------------------------
  public async enqueueOutboxItem(item: {
    conversationId?: string | null;
    orderId?: string | null;
    recipientPhone: string;
    messageType: OutboxMessageType;
    payload: WhatsAppOutboxPayload;
    shopId?: string;
  }): Promise<WhatsAppOutboxItem> {
    if (item.payload?.idempotencyKey) {
      const { data: existing } = await this.supabase
        .from('whatsapp_outbox')
        .select('*')
        .eq('payload->>idempotencyKey', item.payload.idempotencyKey)
        .maybeSingle();

      if (existing) {
        return this.mapOutboxItem(existing);
      }
    }

    let shopId = item.shopId;
    if (!shopId && item.conversationId) {
      const { data: conversation } = await this.supabase
        .from('whatsapp_conversations')
        .select('shop_id')
        .eq('id', item.conversationId)
        .maybeSingle();
      shopId = conversation?.shop_id;
    }
    if (!shopId && item.orderId) {
      const { data: order } = await this.supabase
        .from('print_orders')
        .select('shop_id')
        .eq('id', item.orderId)
        .maybeSingle();
      shopId = order?.shop_id;
    }

    const { data, error } = await this.supabase
      .from('whatsapp_outbox')
      .insert({
        shop_id: shopId || DEFAULT_SHOP_ID,
        conversation_id: item.conversationId || null,
        order_id: item.orderId || null,
        recipient_phone: item.recipientPhone,
        message_type: item.messageType,
        payload: item.payload,
        status: 'PENDING',
        attempt_count: 0,
        max_attempts: 5,
        next_attempt_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Supabase enqueueOutboxItem failed: ${error.message}`);
    }

    return this.mapOutboxItem(data);
  }

  public async claimOutboxBatch(
    workerId: string,
    limit = 10,
    leaseSeconds = 120
  ): Promise<WhatsAppOutboxItem[]> {
    const nowIso = new Date().toISOString();
    const lockedUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();

    const { data: eligible, error: fetchError } = await this.supabase
      .from('whatsapp_outbox')
      .select('*')
      .or(`and(status.in.(PENDING,FAILED),next_attempt_at.lte.${nowIso}),and(status.eq.SENDING,locked_until.lt.${nowIso})`)
      .order('next_attempt_at', { ascending: true })
      .limit(limit);

    if (fetchError || !eligible || eligible.length === 0) {
      return [];
    }

    const claimed: WhatsAppOutboxItem[] = [];
    for (const row of eligible) {
      const { data: updated, error: updateError } = await this.supabase
        .from('whatsapp_outbox')
        .update({
          status: 'SENDING',
          worker_id: workerId,
          locked_until: lockedUntil,
        })
        .eq('id', row.id)
        .select()
        .single();

      if (!updateError && updated) {
        claimed.push(this.mapOutboxItem(updated));
      }
    }

    return claimed;
  }

  public async renewOutboxLease(id: string, workerId: string, additionalSeconds = 120): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const lockedUntil = new Date(Date.now() + additionalSeconds * 1000).toISOString();

    const { data, error } = await this.supabase
      .from('whatsapp_outbox')
      .update({ locked_until: lockedUntil })
      .eq('id', id)
      .eq('worker_id', workerId)
      .gte('locked_until', nowIso)
      .select();

    return !error && data && data.length > 0;
  }

  public async completeOutboxItem(
    id: string,
    workerId: string,
    providerMessageId?: string
  ): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('whatsapp_outbox')
      .update({
        status: 'SENT',
        sent_at: nowIso,
        provider_message_id: providerMessageId || null,
        locked_until: null,
      })
      .eq('id', id)
      .eq('worker_id', workerId)
      .select();

    return !error && data && data.length > 0;
  }

  public async failOutboxItem(id: string, workerId: string, errorMsg: string): Promise<boolean> {
    const { data: current } = await this.supabase
      .from('whatsapp_outbox')
      .select('attempt_count, max_attempts')
      .eq('id', id)
      .eq('worker_id', workerId)
      .single();

    if (!current) return false;

    const nextAttempt = current.attempt_count + 1;
    let nextStatus = 'FAILED';
    let nextAttemptAt = new Date().toISOString();

    if (nextAttempt >= current.max_attempts) {
      nextStatus = 'DEAD_LETTER';
    } else {
      const delayMs = Math.pow(2, nextAttempt) * 2000;
      nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    }

    const { data, error } = await this.supabase
      .from('whatsapp_outbox')
      .update({
        status: nextStatus,
        attempt_count: nextAttempt,
        next_attempt_at: nextAttemptAt,
        last_error: errorMsg,
        locked_until: null,
      })
      .eq('id', id)
      .eq('worker_id', workerId)
      .select();

    return !error && data && data.length > 0;
  }

  // --------------------------------------------------------------------------
  // Phase 2: Message Audit Trail & Documents
  // --------------------------------------------------------------------------
  public async recordWhatsAppMessage(message: {
    conversationId: string;
    messageId: string;
    direction: 'INBOUND' | 'OUTBOUND';
    messageType: string;
    body?: string | null;
    mediaUrl?: string | null;
    mediaMimeType?: string | null;
    rawPayload?: Record<string, unknown>;
  }): Promise<WhatsAppMessage> {
    const { data, error } = await this.supabase
      .from('whatsapp_messages')
      .insert({
        conversation_id: message.conversationId,
        message_id: message.messageId,
        direction: message.direction,
        message_type: message.messageType,
        body: message.body || null,
        media_url: message.mediaUrl || null,
        media_mime_type: message.mediaMimeType || null,
        raw_payload: message.rawPayload || {},
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Supabase recordWhatsAppMessage failed: ${error.message}`);
    }

    return this.mapWhatsAppMessage(data);
  }

  public async listWhatsAppMessages(conversationId: string, limit = 50): Promise<WhatsAppMessage[]> {
    const { data, error } = await this.supabase
      .from('whatsapp_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Supabase listWhatsAppMessages failed: ${error.message}`);
    }

    return (data || []).map((row) => this.mapWhatsAppMessage(row));
  }

  public async verifyDocumentExists(storagePath: string): Promise<boolean> {
    if (!storagePath) return false;
    try {
      const parts = storagePath.split('/');
      const folder = parts.slice(0, -1).join('/');
      const filename = parts[parts.length - 1];
      const bucket = getStorageBucket();
      const { data, error } = await this.supabase.storage
        .from(bucket)
        .list(folder, { search: filename, limit: 1 });
      return !error && Boolean(data && data.length > 0);
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Mappers
  // --------------------------------------------------------------------------
  private mapShop(row: any): Shop {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      phone: row.phone,
      address: row.address,
      currency: row.currency || 'INR',
      isActive: row.is_active ?? true,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapOrder(row: any): PrintOrder {
    return {
      id: row.id,
      shopId: row.shop_id,
      orderNumber: row.order_number,
      customerPhone: row.customer_phone,
      customerName: row.customer_name,
      status: row.status,
      originalFilename: row.original_filename,
      storagePath: row.storage_path,
      fileType: row.file_type,
      fileSize: row.file_size,
      pageCount: row.page_count,
      paperSize: row.paper_size,
      colorMode: row.color_mode,
      printSides: row.print_sides,
      copies: row.copies,
      pageSelection: row.page_selection,
      selectedPageCount: row.selected_page_count,
      subtotalPaisa: row.subtotal_paisa,
      discountPaisa: row.discount_paisa,
      totalAmountPaisa: row.total_amount_paisa,
      currency: row.currency,
      paymentStatus: row.payment_status,
      paymentId: row.payment_id,
      printerId: row.printer_id,
      createdAt: row.created_at,
      paidAt: row.paid_at,
      queuedAt: row.queued_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      failedAt: row.failed_at,
    };
  }

  private mapJob(row: any): PrintJob {
    return {
      id: row.id,
      shopId: row.shop_id,
      orderId: row.order_id,
      printerId: row.printer_id,
      agentId: row.agent_id,
      status: row.status,
      priority: row.priority,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      documentUrl: row.document_url,
      printOptions: row.print_options,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      claimedAt: row.claimed_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      failedAt: row.failed_at,
    };
  }

  private mapAgent(row: any): PrintAgent {
    return {
      id: row.id,
      shopId: row.shop_id,
      agentName: row.agent_name,
      apiKeyHash: row.api_key_hash,
      status: row.status,
      version: row.version,
      capabilities: row.capabilities || {},
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    };
  }

  private mapConversation(row: any): WhatsAppConversation {
    return {
      id: row.id,
      shopId: row.shop_id,
      customerPhone: row.customer_phone,
      whatsappChatId: row.whatsapp_chat_id || row.session_data?.whatsappChatId || null,
      customerName: row.customer_name,
      currentState: row.current_state,
      activeOrderId: row.active_order_id,
      sessionData: row.session_data || {},
      version: row.version || 1,
      lastInteractionAt: row.last_interaction_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapInboxItem(row: any): WhatsAppInboxItem {
    return {
      id: row.id,
      shopId: row.shop_id,
      messageId: row.message_id,
      senderPhone: row.sender_phone,
      rawPayload: row.raw_payload || {},
      status: row.status,
      workerId: row.worker_id,
      lockedUntil: row.locked_until,
      processingStartedAt: row.processing_started_at,
      attemptCount: row.attempt_count || 0,
      maxAttempts: row.max_attempts || 5,
      lastError: row.last_error,
      receivedAt: row.received_at,
      processedAt: row.processed_at,
    };
  }

  private mapOutboxItem(row: any): WhatsAppOutboxItem {
    return {
      id: row.id,
      shopId: row.shop_id,
      conversationId: row.conversation_id,
      orderId: row.order_id,
      recipientPhone: row.recipient_phone,
      messageType: row.message_type,
      payload: row.payload || {},
      status: row.status,
      workerId: row.worker_id,
      lockedUntil: row.locked_until,
      attemptCount: row.attempt_count || 0,
      maxAttempts: row.max_attempts || 5,
      nextAttemptAt: row.next_attempt_at,
      providerMessageId: row.provider_message_id,
      lastError: row.last_error,
      createdAt: row.created_at,
      sentAt: row.sent_at,
    };
  }

  private mapWhatsAppMessage(row: any): WhatsAppMessage {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      direction: row.direction,
      messageType: row.message_type,
      body: row.body,
      mediaUrl: row.media_url,
      mediaMimeType: row.media_mime_type,
      rawPayload: row.raw_payload || {},
      createdAt: row.created_at,
    };
  }
}
