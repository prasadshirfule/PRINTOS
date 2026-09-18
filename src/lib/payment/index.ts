import { IPaymentProvider } from '@/types/payment';
import { MockPaymentProvider } from './mock-payment-provider';

export * from './mock-payment-provider';
export * from './fulfillability-policy';

let cachedPaymentProvider: IPaymentProvider | null = null;

export function getPaymentProvider(): IPaymentProvider {
  if (cachedPaymentProvider) {
    return cachedPaymentProvider;
  }
  cachedPaymentProvider = new MockPaymentProvider();
  return cachedPaymentProvider;
}

export function setPaymentProvider(provider: IPaymentProvider): void {
  cachedPaymentProvider = provider;
}
