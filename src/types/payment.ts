export interface PaymentIntentResult {
  paymentId: string;
  amountPaisa: number;
  currency: string;
  paymentUrl?: string;
  qrPayload?: string;
  expiresAt: string;
}

export interface PaymentWebhookVerification {
  isValid: boolean;
  orderId: string;
  transactionId: string;
  provider: string;
  amountPaisa: number;
  status: 'SUCCESS' | 'FAILED';
  rawPayload: Record<string, unknown>;
}

export interface FulfillabilityAssessment {
  fulfillable: boolean;
  reason?: 'HARDWARE_OFFLINE' | 'CAPABILITY_MISMATCH' | 'FILE_EXPIRED' | 'SHOP_CLOSED_HARD' | 'OK';
}

export interface IPaymentProvider {
  createPaymentIntent(orderId: string, amountPaisa: number, customerPhone: string): Promise<PaymentIntentResult>;
  verifyWebhook(headers: Record<string, string>, rawBody: string): Promise<PaymentWebhookVerification>;
  getPaymentStatus(paymentId: string): Promise<'PENDING' | 'SUCCESS' | 'FAILED'>;
}
