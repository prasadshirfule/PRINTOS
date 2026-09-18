export interface PaymentIntentResult {
  paymentId: string;
  amountPaisa: number;
  currency: string;
  paymentUrl?: string;
  qrPayload?: string;
  upiIntentUrl?: string;
  orderNumber?: string;
  expiresAt: string;
}

export interface CreatePaymentIntentOptions {
  orderId: string;
  orderNumber?: string;
  amountPaisa: number;
  customerPhone: string;
  customerName?: string | null;
  description?: string;
}

export interface PaymentWebhookVerification {
  isValid: boolean;
  orderId: string;
  transactionId: string;
  provider: string;
  amountPaisa: number;
  status: 'SUCCESS' | 'FAILED';
  rawPayload: Record<string, unknown>;
  error?: string;
}

export interface FulfillabilityAssessment {
  fulfillable: boolean;
  reason?: 'HARDWARE_OFFLINE' | 'CAPABILITY_MISMATCH' | 'FILE_EXPIRED' | 'SHOP_CLOSED_HARD' | 'OK';
}

export interface RazorpayConfig {
  keyId?: string;
  keySecret?: string;
  webhookSecret?: string;
  merchantVpa?: string; // UPI VPA e.g. printos@upi
  merchantName?: string;
}

export interface IPaymentProvider {
  createPaymentIntent(
    options: CreatePaymentIntentOptions | string,
    amountPaisa?: number,
    customerPhone?: string
  ): Promise<PaymentIntentResult>;
  verifyWebhook(headers: Record<string, string>, rawBody: string): Promise<PaymentWebhookVerification>;
  getPaymentStatus(paymentId: string): Promise<'PENDING' | 'SUCCESS' | 'FAILED'>;
}
