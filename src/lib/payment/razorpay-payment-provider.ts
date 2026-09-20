import crypto from 'crypto';
import {
  IPaymentProvider,
  PaymentIntentResult,
  PaymentWebhookVerification,
  CreatePaymentIntentOptions,
  RazorpayConfig,
} from '@/types/payment';

export class RazorpayPaymentProvider implements IPaymentProvider {
  private keyId: string;
  private keySecret: string;
  private webhookSecret: string;
  private merchantVpa: string;
  private merchantName: string;

  constructor(config?: RazorpayConfig) {
    this.keyId = config?.keyId || process.env.RAZORPAY_KEY_ID || '';
    this.keySecret = config?.keySecret || process.env.RAZORPAY_KEY_SECRET || '';
    this.webhookSecret = config?.webhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET || '';
    this.merchantVpa = config?.merchantVpa || process.env.UPI_MERCHANT_VPA || 'printos@upi';
    this.merchantName = config?.merchantName || process.env.UPI_MERCHANT_NAME || 'PRINTOS Print Shop';

    if (process.env.NODE_ENV === 'production' && (!this.keyId || !this.keySecret || !this.webhookSecret)) {
      throw new Error('Razorpay key ID, key secret, and webhook secret are required in production.');
    }
  }

  /**
   * Generates a payment intent with dynamic UPI deep links and Razorpay checkout parameters
   */
  public async createPaymentIntent(
    optionsOrOrderId: CreatePaymentIntentOptions | string,
    amountPaisaArg?: number,
    customerPhoneArg?: string
  ): Promise<PaymentIntentResult> {
    let orderId: string;
    let orderNumber: string;
    let amountPaisa: number;
    let customerPhone: string;
    let customerName: string | null | undefined;
    let description: string;

    if (typeof optionsOrOrderId === 'object') {
      orderId = optionsOrOrderId.orderId;
      orderNumber = optionsOrOrderId.orderNumber || orderId;
      amountPaisa = optionsOrOrderId.amountPaisa;
      customerPhone = optionsOrOrderId.customerPhone;
      customerName = optionsOrOrderId.customerName;
      description = optionsOrOrderId.description || `PRINTOS Order ${orderNumber}`;
    } else {
      orderId = optionsOrOrderId;
      orderNumber = orderId;
      amountPaisa = amountPaisaArg || 0;
      customerPhone = customerPhoneArg || '';
      customerName = undefined;
      description = `PRINTOS Order ${orderNumber}`;
    }

    if (!this.keyId || !this.keySecret) {
      throw new Error('Razorpay key ID and key secret are required to create a payment link.');
    }

    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
    
    const cleanCustomerPhone = customerPhone ? customerPhone.trim() : '';
    const isRealPhone =
      Boolean(cleanCustomerPhone) &&
      !cleanCustomerPhone.includes('@') &&
      /^\+?[1-9]\d{9,13}$/.test(cleanCustomerPhone);

    const customerPayload: { name?: string; contact?: string } = {};
    if (customerName?.trim()) {
      customerPayload.name = customerName.trim();
    }
    if (isRealPhone) {
      customerPayload.contact = cleanCustomerPhone.replace(/\D/g, '');
    }

    const response = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountPaisa,
        currency: 'INR',
        reference_id: `po_${orderId}`,
        description,
        ...(Object.keys(customerPayload).length > 0 ? { customer: customerPayload } : {}),
        notes: { printosOrderId: orderId, orderId },
        reminder_enable: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Razorpay payment-link creation failed (${response.status}): ${await response.text()}`);
    }

    const link = (await response.json()) as { id?: string; short_url?: string; expire_by?: number };
    if (!link.id || !link.short_url) {
      throw new Error('Razorpay did not return a payment link ID and short URL.');
    }

    const expiresAt = link.expire_by
      ? new Date(link.expire_by * 1000).toISOString()
      : new Date(Date.now() + 20 * 60 * 1000).toISOString();

    const upiAmount = (amountPaisa / 100).toFixed(2);
    const upiIntentUrl = `upi://pay?pa=${this.merchantVpa}&pn=${encodeURIComponent(this.merchantName)}&am=${upiAmount}&cu=INR&tr=${orderNumber}&tn=${encodeURIComponent(description)}`;

    return {
      paymentId: link.id,
      amountPaisa,
      currency: 'INR',
      paymentUrl: link.short_url,
      upiIntentUrl,
      orderNumber,
      expiresAt,
    };
  }

  /**
   * Verifies Razorpay webhook payload and cryptographic HMAC-SHA256 signature
   */
  public async verifyWebhook(
    headers: Record<string, string>,
    rawBody: string
  ): Promise<PaymentWebhookVerification> {
    try {
      const normalizedHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        normalizedHeaders[k.toLowerCase()] = v;
      }

      const receivedSignature =
        normalizedHeaders['x-razorpay-signature'] ||
        normalizedHeaders['x-razorpay-signature-256'] ||
        '';

      if (!this.webhookSecret || !receivedSignature) {
        return {
          isValid: false,
          orderId: '',
          transactionId: '',
          provider: 'RAZORPAY_UPI',
          amountPaisa: 0,
          status: 'FAILED',
          rawPayload: {},
          error: 'Missing X-Razorpay-Signature header',
        };
      }

      const expectedSignature = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(rawBody)
        .digest('hex');

      const sigBuffer = Buffer.from(receivedSignature, 'utf8');
      const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

      if (
        sigBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
      ) {
        return {
          isValid: false,
          orderId: '',
          transactionId: '',
          provider: 'RAZORPAY_UPI',
          amountPaisa: 0,
          status: 'FAILED',
          rawPayload: {},
          error: 'Invalid Razorpay webhook signature',
        };
      }

      const data = JSON.parse(rawBody);

      // Handle standard Razorpay webhook event schemas
      let orderId = '';
      let transactionId = '';
      let amountPaisa = 0;
      let status: 'SUCCESS' | 'FAILED' = 'FAILED';

      const eventName = data.event as string | undefined;

      if (data.payload && data.payload.payment && data.payload.payment.entity) {
        const p = data.payload.payment.entity;
        transactionId = p.id || `pay_${Date.now()}`;
        amountPaisa = typeof p.amount === 'number' ? p.amount : Math.round((Number(p.amount) || 0));
        const paymentLink = data.payload?.payment_link?.entity;
        orderId =
          p.notes?.printosOrderId ||
          p.notes?.orderId ||
          paymentLink?.notes?.printosOrderId ||
          paymentLink?.notes?.orderId ||
          paymentLink?.reference_id?.replace(/^(printos_|po_)/, '') ||
          p.notes?.order_id ||
          p.description?.match(/Order\s+([A-Za-z0-9-]+)/i)?.[1] ||
          p.order_id ||
          '';

        const paymentStatus = (p.status || '').toLowerCase();
        if (eventName === 'payment.captured' || eventName === 'order.paid' || paymentStatus === 'captured') {
          status = 'SUCCESS';
        } else if (eventName === 'payment.failed' || paymentStatus === 'failed') {
          status = 'FAILED';
        } else {
          status = paymentStatus === 'authorized' ? 'SUCCESS' : 'FAILED';
        }
      } else {
        // Direct / simplified webhook payload format
        orderId = data.orderId || data.order_id || data.notes?.printosOrderId || data.notes?.orderId || '';
        transactionId = data.paymentId || data.transactionId || data.id || `pay_${Date.now()}`;
        amountPaisa = typeof data.amountPaisa === 'number' ? data.amountPaisa : data.amount || 0;
        status = data.status === 'SUCCESS' || data.status === 'captured' || data.event === 'payment.captured' ? 'SUCCESS' : 'FAILED';
      }

      return {
        isValid: true,
        orderId,
        transactionId,
        provider: 'RAZORPAY_UPI',
        amountPaisa,
        status,
        rawPayload: data,
      };
    } catch (err: unknown) {
      return {
        isValid: false,
        orderId: '',
        transactionId: '',
        provider: 'RAZORPAY_UPI',
        amountPaisa: 0,
        status: 'FAILED',
        rawPayload: {},
        error: err instanceof Error ? err.message : 'Failed to parse webhook body',
      };
    }
  }

  public async getPaymentStatus(paymentId: string): Promise<'PENDING' | 'SUCCESS' | 'FAILED'> {
    if (!this.keyId || !this.keySecret) {
      return 'PENDING';
    }
    // Stub for live API polling if needed
    return 'PENDING';
  }
}
