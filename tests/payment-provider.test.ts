import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import {
  RazorpayPaymentProvider,
  MockPaymentProvider,
  getPaymentProvider,
  setPaymentProvider,
} from '@/lib/payment';

describe('Payment Provider Abstraction Layer', () => {
  const testWebhookSecret = 'test_webhook_secret_key_12345';

  beforeEach(() => {
    setPaymentProvider(null);
  });

  afterEach(() => {
    setPaymentProvider(null);
    vi.restoreAllMocks();
  });

  describe('RazorpayPaymentProvider', () => {
    const razorpay = new RazorpayPaymentProvider({
      keyId: 'rzp_test_key_123',
      keySecret: 'rzp_test_secret_456',
      webhookSecret: testWebhookSecret,
      merchantVpa: 'testshop@upi',
      merchantName: 'Test Print Shop',
    });

    it('generates a valid payment intent with standard NPCI UPI URI and checkout link', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'plink_test_123',
          short_url: 'https://rzp.io/i/plink_test_123',
          expire_by: Math.floor(Date.now() / 1000) + 1800,
        }),
      } as any);

      try {
        const intent = await razorpay.createPaymentIntent({
          orderId: 'ord_12345',
          orderNumber: 'P1001',
          amountPaisa: 4800, // ₹48.00
          customerPhone: '+919876543210',
        });

        expect(intent.amountPaisa).toBe(4800);
        expect(intent.currency).toBe('INR');
        expect(intent.orderNumber).toBe('P1001');
        expect(intent.upiIntentUrl).toContain('upi://pay?');
        expect(intent.upiIntentUrl).toContain('pa=testshop@upi');
        expect(intent.upiIntentUrl).toContain('am=48.00');
        expect(intent.paymentUrl).toContain('rzp.io/i/');

        // Verify request payload sent to Razorpay API
        const fetchCalls = (global.fetch as any).mock.calls;
        const lastBody = JSON.parse(fetchCalls[fetchCalls.length - 1][1].body);
        expect(lastBody.reference_id).toBe('po_ord_12345');
        expect(lastBody.reference_id.length).toBeLessThanOrEqual(40);
        expect(lastBody.notes.printosOrderId).toBe('ord_12345');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('ensures reference_id is <= 40 characters for any full standard 36-char UUID', async () => {
      const originalFetch = global.fetch;
      const testUuid = '123e4567-e89b-12d3-a456-426614174000'; // Standard 36-char UUID
      let capturedBody: any;

      global.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            id: 'plink_uuid_test',
            short_url: 'https://rzp.io/i/plink_uuid_test',
            expire_by: Math.floor(Date.now() / 1000) + 1800,
          }),
        };
      });

      try {
        await razorpay.createPaymentIntent({
          orderId: testUuid,
          orderNumber: 'P9999',
          amountPaisa: 200,
          customerPhone: '+919876543210',
        });

        expect(capturedBody).toBeDefined();
        expect(capturedBody.reference_id).toBe(`po_${testUuid}`);
        expect(capturedBody.reference_id.length).toBe(39);
        expect(capturedBody.reference_id.length).toBeLessThanOrEqual(40);
        expect(capturedBody.notes.printosOrderId).toBe(testUuid);
        expect(capturedBody.notes.orderId).toBe(testUuid);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('reconciles order ID from payment_link entity reference_id with po_ prefix', async () => {
      const testUuid = '8d7c2a1e-5f3b-4c6d-9e0a-1b2c3d4e5f6a';
      const payload = {
        event: 'payment_link.paid',
        payload: {
          payment: {
            entity: {
              id: 'pay_link_paid_123',
              amount: 200,
              currency: 'INR',
              status: 'captured',
            },
          },
          payment_link: {
            entity: {
              id: 'plink_link_paid_123',
              reference_id: `po_${testUuid}`,
            },
          },
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha256', testWebhookSecret)
        .update(rawBody)
        .digest('hex');

      const verification = await razorpay.verifyWebhook(
        { 'x-razorpay-signature': signature },
        rawBody
      );

      expect(verification.isValid).toBe(true);
      expect(verification.orderId).toBe(testUuid);
      expect(verification.amountPaisa).toBe(200);
      expect(verification.status).toBe('SUCCESS');
    });

    it('verifies a valid webhook payload with correct HMAC-SHA256 signature', async () => {
      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_99887766',
              amount: 4800,
              currency: 'INR',
              status: 'captured',
              order_id: 'order_rzp_123',
              notes: {
                orderId: 'ord_12345',
              },
            },
          },
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha256', testWebhookSecret)
        .update(rawBody)
        .digest('hex');

      const verification = await razorpay.verifyWebhook(
        { 'x-razorpay-signature': signature },
        rawBody
      );

      expect(verification.isValid).toBe(true);
      expect(verification.orderId).toBe('ord_12345');
      expect(verification.transactionId).toBe('pay_99887766');
      expect(verification.amountPaisa).toBe(4800);
      expect(verification.status).toBe('SUCCESS');
      expect(verification.provider).toBe('RAZORPAY_UPI');
    });

    it('rejects an invalid webhook signature with HTTP 400 validation error', async () => {
      const payload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_tampered',
              amount: 100,
              status: 'captured',
            },
          },
        },
      };

      const rawBody = JSON.stringify(payload);
      const badSignature = 'invalid_tampered_signature_hex_value';

      const verification = await razorpay.verifyWebhook(
        { 'x-razorpay-signature': badSignature },
        rawBody
      );

      expect(verification.isValid).toBe(false);
      expect(verification.error).toBe('Invalid Razorpay webhook signature');
    });

    it('rejects a webhook request when signature header is missing', async () => {
      const rawBody = JSON.stringify({ event: 'payment.captured' });
      const verification = await razorpay.verifyWebhook({}, rawBody);

      expect(verification.isValid).toBe(false);
      expect(verification.error).toBe('Missing X-Razorpay-Signature header');
    });

    it('correctly maps payment.failed status to FAILED', async () => {
      const payload = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_failed_123',
              amount: 2500,
              status: 'failed',
              notes: { orderId: 'ord_failed_1' },
            },
          },
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha256', testWebhookSecret)
        .update(rawBody)
        .digest('hex');

      const verification = await razorpay.verifyWebhook(
        { 'x-razorpay-signature': signature },
        rawBody
      );

      expect(verification.isValid).toBe(true);
      expect(verification.status).toBe('FAILED');
      expect(verification.amountPaisa).toBe(2500);
    });
  });

  describe('MockPaymentProvider', () => {
    it('generates mock payment intent and validates simulated webhooks', async () => {
      const mockProvider = new MockPaymentProvider();
      const intent = await mockProvider.createPaymentIntent({
        orderId: 'mock_ord_1',
        orderNumber: 'P2002',
        amountPaisa: 1500,
        customerPhone: '+919999999999',
      });

      expect(intent.amountPaisa).toBe(1500);
      expect(intent.paymentUrl).toContain('pay.printos.local');

      const verification = await mockProvider.verifyWebhook(
        {},
        JSON.stringify({
          orderId: 'mock_ord_1',
          paymentId: intent.paymentId,
          amountPaisa: 1500,
          status: 'SUCCESS',
        })
      );

      expect(verification.isValid).toBe(true);
      expect(verification.orderId).toBe('mock_ord_1');
      expect(verification.transactionId).toBe(intent.paymentId);
      expect(verification.status).toBe('SUCCESS');
    });
  });

  describe('Payment Provider Factory', () => {
    it('returns default MockPaymentProvider in test/development when env is unset', () => {
      const provider = getPaymentProvider();
      expect(provider).toBeInstanceOf(MockPaymentProvider);
    });

    it('supports custom provider injection via setPaymentProvider', () => {
      const custom = new MockPaymentProvider();
      setPaymentProvider(custom);
      expect(getPaymentProvider()).toBe(custom);
    });
  });
});
