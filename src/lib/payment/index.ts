import { IPaymentProvider } from '@/types/payment';
import { MockPaymentProvider } from './mock-payment-provider';
import { RazorpayPaymentProvider } from './razorpay-payment-provider';

export * from './mock-payment-provider';
export * from './razorpay-payment-provider';
export * from './fulfillability-policy';

let cachedPaymentProvider: IPaymentProvider | null = null;

export function getPaymentProvider(): IPaymentProvider {
  if (cachedPaymentProvider) {
    return cachedPaymentProvider;
  }

  const providerType = (process.env.PAYMENT_PROVIDER || '').toLowerCase();
  if (providerType === 'razorpay' || process.env.RAZORPAY_KEY_ID) {
    cachedPaymentProvider = new RazorpayPaymentProvider();
  } else {
    cachedPaymentProvider = new MockPaymentProvider();
  }

  return cachedPaymentProvider;
}

export function setPaymentProvider(provider: IPaymentProvider | null): void {
  cachedPaymentProvider = provider;
}
