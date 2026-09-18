import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import {
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
import { OrderStateMachine } from '@/lib/orders/state-machine';
import {
  IPrintOSRepository,
  DashboardMetrics,
  UnauthorizedAgentJobError,
  ResourceNotFoundError,
} from './repository.interface';

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

  public async createOrder(order: PrintOrder): Promise<PrintOrder> {
    const { data, error } = await this.supabase
      .from('print_orders')
      .insert({
        id: order.id,
        shop_id: order.shopId || null,
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

  public async listOrders(filters?: { status?: OrderStatus; limit?: number }): Promise<PrintOrder[]> {
    let query = this.supabase
      .from('print_orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (filters?.status) {
      query = query.eq('status', filters.status);
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
    if (nextStatus === 'PRINTING' && !existing.startedAt) updatePayload.started_at = now;
    if (nextStatus === 'COMPLETED') updatePayload.completed_at = now;
    if (nextStatus === 'FAILED') updatePayload.failed_at = now;

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
      `STATUS_CHANGE_${nextStatus}`,
      `Order status transitioned from ${prevStatus} to ${nextStatus}`,
      metadata
    );

    return this.mapOrder(data);
  }

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
      metadata: data.metadata,
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
      metadata: row.metadata,
      createdAt: row.created_at,
    }));
  }

  public async simulateVerifiedPayment(
    orderId: string,
    transactionId: string,
    provider = 'MOCK_UPI',
    amountPaisa?: number
  ): Promise<{ order: PrintOrder; job: PrintJob; isDuplicate: boolean }> {
    const order = await this.getOrder(orderId);
    if (!order) {
      throw new ResourceNotFoundError('Order', orderId);
    }

    if (amountPaisa !== undefined && amountPaisa !== order.totalAmountPaisa) {
      throw new Error(
        `Payment verification failed: Gateway amount (${amountPaisa} paisa) does not match order amount (${order.totalAmountPaisa} paisa).`
      );
    }

    // Check existing transaction for idempotency
    const { data: existingTx } = await this.supabase
      .from('payment_transactions')
      .select('*')
      .eq('provider', provider)
      .eq('transaction_id', transactionId)
      .maybeSingle();

    if (existingTx || order.paymentStatus === 'PAID') {
      const existingJob = await this.getJobByOrderId(orderId);
      if (!existingJob) {
        throw new Error('Order marked paid but print job missing in Supabase.');
      }
      return { order, job: existingJob, isDuplicate: true };
    }

    // Insert transaction row with unique constraint (provider, transaction_id)
    const { error: txError } = await this.supabase.from('payment_transactions').insert({
      order_id: orderId,
      provider,
      transaction_id: transactionId,
      idempotency_key: `${provider}:${transactionId}`,
      amount_paisa: order.totalAmountPaisa,
      currency: order.currency,
      status: 'SUCCESS',
      raw_payload: { simulated: true },
    });

    if (txError) {
      // If code 23505 (unique_violation), duplicate webhook occurred concurrently
      if (txError.code === '23505') {
        const existingJob = await this.getJobByOrderId(orderId);
        if (existingJob) {
          return { order, job: existingJob, isDuplicate: true };
        }
      }
      throw new Error(`Failed to record payment transaction: ${txError.message}`);
    }

    // Update order status to PAID
    await this.updateOrderStatus(orderId, 'PAID', { transactionId, provider });
    await this.supabase
      .from('print_orders')
      .update({ payment_status: 'PAID', payment_id: transactionId })
      .eq('id', orderId);

    // Update order status to QUEUED
    await this.updateOrderStatus(orderId, 'QUEUED');

    // Create print job with unique constraint on order_id
    const { data: jobData, error: jobError } = await this.supabase
      .from('print_jobs')
      .insert({
        order_id: order.id,
        printer_id: order.printerId || null,
        agent_id: null,
        status: 'QUEUED',
        priority: 10,
        attempt_count: 0,
        max_attempts: 3,
        document_url: `/api/agent/jobs/${order.id}/document`,
        print_options: {
          copies: order.copies,
          paperSize: order.paperSize,
          colorMode: order.colorMode,
          printSides: order.printSides,
          pageSelection: order.pageSelection,
        },
      })
      .select()
      .single();

    if (jobError) {
      if (jobError.code === '23505') {
        const existingJob = await this.getJobByOrderId(orderId);
        if (existingJob) {
          return { order, job: existingJob, isDuplicate: true };
        }
      }
      throw new Error(`Failed to create print job in Supabase: ${jobError.message}`);
    }

    await this.recordOrderEvent(orderId, 'PRINT_QUEUED', 'Print job added to printer queue', {
      jobId: jobData.id,
      printerId: jobData.printer_id,
    });

    const updatedOrder = (await this.getOrder(orderId)) || order;
    return { order: updatedOrder, job: this.mapJob(jobData), isDuplicate: false };
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

  public async listJobs(filters?: { status?: JobStatus; limit?: number }): Promise<PrintJob[]> {
    let query = this.supabase
      .from('print_jobs')
      .select('*')
      .order('created_at', { ascending: false });

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
  public async claimNextPrintJob(agentId: string, printerId?: string): Promise<ClaimedJob | null> {
    const { data, error } = await this.supabase.rpc('claim_next_print_job', {
      p_agent_id: agentId,
      p_printer_id: printerId || null,
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

    // Strict Authorization: only claiming agent can mutate job
    if (job.agentId && job.agentId !== agentId) {
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
    agentName: string,
    printerStatus: PrinterStatus,
    capabilities?: Record<string, unknown>,
    version = '1.0.0'
  ): Promise<PrintAgent> {
    const now = new Date().toISOString();

    const { data, error } = await this.supabase
      .from('print_agents')
      .upsert(
        {
          agent_name: agentName,
          status: 'ONLINE',
          version,
          capabilities: capabilities || {},
          last_seen_at: now,
        },
        { onConflict: 'agent_name' }
      )
      .select()
      .single();

    if (error) {
      throw new Error(`Supabase recordAgentHeartbeat failed: ${error.message}`);
    }

    // Update printer last_seen_at
    await this.supabase
      .from('printers')
      .update({ status: printerStatus, last_seen_at: now })
      .eq('id', '00000000-0000-0000-0000-000000000001');

    return this.mapAgent(data);
  }

  public async listPrinters(): Promise<Printer[]> {
    const { data, error } = await this.supabase.from('printers').select('*');
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

  public async getDashboardMetrics(): Promise<DashboardMetrics> {
    const orders = await this.listOrders();
    const queuedCount = orders.filter((o) => o.status === 'QUEUED').length;
    const printingCount = orders.filter((o) => o.status === 'PRINTING').length;
    const completedCount = orders.filter((o) => o.status === 'COMPLETED').length;
    const failedCount = orders.filter((o) => o.status === 'FAILED').length;
    const totalRevenuePaisa = orders
      .filter((o) => o.paymentStatus === 'PAID')
      .reduce((sum, o) => sum + o.totalAmountPaisa, 0);
    const totalPagesPrinted = orders
      .filter((o) => o.status === 'COMPLETED')
      .reduce((sum, o) => sum + o.selectedPageCount * o.copies, 0);

    return {
      todayOrders: orders.length,
      queued: queuedCount,
      printing: printingCount,
      completed: completedCount,
      failed: failedCount,
      revenuePaisa: totalRevenuePaisa,
      pagesPrinted: totalPagesPrinted,
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
}