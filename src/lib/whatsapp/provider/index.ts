import { IWhatsAppProvider } from '@/types/whatsapp';
import { MockWhatsAppProvider } from './mock-whatsapp-provider';
import { MetaWhatsAppProvider } from './meta-whatsapp-provider';
import { OpenWAWhatsAppProvider } from './openwa-whatsapp-provider';

export * from './mock-whatsapp-provider';
export * from './meta-whatsapp-provider';
export * from './openwa-whatsapp-provider';

let cachedProvider: IWhatsAppProvider | null = null;

export function getWhatsAppProvider(): IWhatsAppProvider {
  if (cachedProvider) {
    return cachedProvider;
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const providerType = (process.env.WHATSAPP_PROVIDER || '').toLowerCase().trim();

  // 1. Explicit OpenWA Provider
  if (providerType === 'openwa' || (!providerType && process.env.OPENWA_API_KEY && process.env.OPENWA_BASE_URL)) {
    if (isProduction && (!process.env.OPENWA_API_KEY || !process.env.OPENWA_BASE_URL)) {
      throw new Error(
        '[PRINTOS] Production is configured for WHATSAPP_PROVIDER=openwa but required OPENWA_API_KEY or OPENWA_BASE_URL is missing.'
      );
    }
    cachedProvider = new OpenWAWhatsAppProvider();
    return cachedProvider;
  }

  // 2. Explicit Meta Cloud API Provider
  if (providerType === 'meta' || (!providerType && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN)) {
    if (isProduction && (!process.env.WHATSAPP_PHONE_NUMBER_ID || !process.env.WHATSAPP_ACCESS_TOKEN)) {
      throw new Error(
        '[PRINTOS] Production is configured for WHATSAPP_PROVIDER=meta but required WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN is missing.'
      );
    }
    cachedProvider = new MetaWhatsAppProvider();
    return cachedProvider;
  }

  // 3. Explicit Mock Provider
  if (providerType === 'mock') {
    cachedProvider = new MockWhatsAppProvider();
    return cachedProvider;
  }

  // 4. Default / Fallback handling
  if (isProduction) {
    throw new Error(
      '[PRINTOS] Production requires a valid WHATSAPP_PROVIDER ("openwa" or "meta") with corresponding environment credentials.'
    );
  }

  cachedProvider = new MockWhatsAppProvider();
  return cachedProvider;
}

export function setWhatsAppProvider(provider: IWhatsAppProvider | null): void {
  cachedProvider = provider;
}
