import crypto from 'crypto';
import { IPaymentProvider, PaymentIntentResult, PaymentWebhookVerification } from '@/types/payment';

export class MockPaymentProvider implements IPaymentProvider {
  public payments: Map<
    string,
    { orderId: string; amountPaisa: number; customerPhone: string; status: 'PENDING' | 'SUCCESS' | 'FAILED' }
  > = new Map();

  public async createPaymentIntent(
    orderId: string,
    amountPaisa: number,
    customerPhone: string
  ): Promise<PaymentIntentResult> {
    const paymentId = `mock_pay_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 mins

    this.payments.set(paymentId, {
      orderId,
      amountPaisa,
      customerPhone,
      status: 'PENDING',
    });

    const paymentUrl = `https://pay.printos.local/checkout/${paymentId}?order=${orderId}&amount=${amountPaisa}`;
    const qrPayload = `upi://pay?pa=printos@upi&pn=PRINTOS&am=${(amountPaisa / 100).toFixed(2)}&tr=${paymentId}&tn=Order%20${orderId}`;

    return {
      paymentId,
      amountPaisa,
      currency: 'INR',
      paymentUrl,
      qrPayload,
      expiresAt,
    };
  }

  public async verifyWebhook(
    headers: Record<string, string>,
    rawBody: string
  ): Promise<PaymentWebhookVerification> {
    try {
      const data = JSON.parse(rawBody);
      const paymentId = data.paymentId || data.transactionId || `tx_${Date.now()}`;
      const orderId = data.orderId;
      const amountPaisa = data.amountPaisa || data.amount || 0;
      const status = data.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED';

      // Update in-memory record if exists
      if (this.payments.has(paymentId)) {
        const p = this.payments.get(paymentId)!;
        p.status = status;
      }

      return {
        isValid: true,
        orderId,
        transactionId: paymentId,
        provider: 'MOCK_RAZORPAY_UPI',
        amountPaisa,
        status,
        rawPayload: data,
      };
    } catch {
      return {
        isValid: false,
        orderId: '',
        transactionId: '',
        provider: 'MOCK_RAZORPAY_UPI',
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
