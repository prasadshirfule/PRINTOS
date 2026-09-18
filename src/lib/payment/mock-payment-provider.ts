import crypto from 'crypto';
import {
  IPaymentProvider,
  PaymentIntentResult,
  PaymentWebhookVerification,
  CreatePaymentIntentOptions,
} from '@/types/payment';

export class MockPaymentProvider implements IPaymentProvider {
  public payments: Map<
    string,
    { orderId: string; amountPaisa: number; customerPhone: string; status: 'PENDING' | 'SUCCESS' | 'FAILED' }
  > = new Map();

  public async createPaymentIntent(
    optionsOrOrderId: CreatePaymentIntentOptions | string,
    amountPaisaArg?: number,
    customerPhoneArg?: string
  ): Promise<PaymentIntentResult> {
    let orderId: string;
    let orderNumber: string;
    let amountPaisa: number;
    let customerPhone: string;

    if (typeof optionsOrOrderId === 'object') {
      orderId = optionsOrOrderId.orderId;
      orderNumber = optionsOrOrderId.orderNumber || orderId;
      amountPaisa = optionsOrOrderId.amountPaisa;
      customerPhone = optionsOrOrderId.customerPhone;
    } else {
      orderId = optionsOrOrderId;
      orderNumber = orderId;
      amountPaisa = amountPaisaArg || 0;
      customerPhone = customerPhoneArg || '';
    }

    const paymentId = `mock_pay_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 mins

    this.payments.set(paymentId, {
      orderId,
      amountPaisa,
      customerPhone,
      status: 'PENDING',
    });

    const amountRupees = (amountPaisa / 100).toFixed(2);
    const paymentUrl = `https://pay.printos.local/checkout/${paymentId}?order=${orderId}&amount=${amountPaisa}`;
    const upiIntentUrl = `upi://pay?pa=printos@upi&pn=PRINTOS&am=${amountRupees}&cu=INR&tr=${orderNumber}&tn=Order%20${orderNumber}`;

    return {
      paymentId,
      amountPaisa,
      currency: 'INR',
      paymentUrl,
      qrPayload: upiIntentUrl,
      upiIntentUrl,
      orderNumber,
      expiresAt,
    };
  }

  public async verifyWebhook(
    headers: Record<string, string>,
    rawBody: string
  ): Promise<PaymentWebhookVerification> {
    try {
      const data = JSON.parse(rawBody);
      const paymentId = data.paymentId || data.transactionId || data.id || `tx_${Date.now()}`;
      const orderId = data.orderId || data.order_id || '';
      const amountPaisa = typeof data.amountPaisa === 'number' ? data.amountPaisa : data.amount || 0;
      const status = data.status === 'SUCCESS' || data.status === 'captured' ? 'SUCCESS' : 'FAILED';

      // Update in-memory record if exists
      if (this.payments.has(paymentId)) {
        const p = this.payments.get(paymentId)!;
        p.status = status;
      }

      return {
        isValid: true,
        orderId,
        transactionId: paymentId,
        provider: 'MOCK_PAYMENT_PROVIDER',
        amountPaisa,
        status,
        rawPayload: data,
      };
    } catch {
      return {
        isValid: false,
        orderId: '',
        transactionId: '',
        provider: 'MOCK_PAYMENT_PROVIDER',
        amountPaisa: 0,
        status: 'FAILED',
        rawPayload: {},
      };
    }
  }

  public async getPaymentStatus(paymentId: string): Promise<'PENDING' | 'SUCCESS' | 'FAILED'> {
    const payment = this.payments.get(paymentId);
    return payment ? payment.status : 'PENDING';
  }

  public markPaymentSuccess(paymentId: string): void {
    const payment = this.payments.get(paymentId);
    if (payment) {
      payment.status = 'SUCCESS';
    }
  }
}
