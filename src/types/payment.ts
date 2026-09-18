export interface PaymentOrderResult {
  paymentId: string;
  amountPaisa: number;
  currency: string;
  paymentUrl?: string;
  upiQrString?: string;
}

export interface PaymentVerificationResult {
  verified: boolean;
  orderId: string;
  transactionId: string;
  amountPaisa: number;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
}

export interface IPaymentProvider {
  createPaymentOrder(orderId: string, amountPaisa: number, customerPhone: string): Promise<PaymentOrderResult>;
  verifyPayment(paymentId: string): Promise<PaymentVerificationResult>;
  processWebhook(headers: Record<string, string>, rawBody: string): Promise<PaymentVerificationResult>;
}
