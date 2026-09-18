import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getRepository } from '@/lib/repository';
import { DEFAULT_SHOP_ID, Shop, PrintOrder } from '@/types/printos';
import { createAdminToken, ADMIN_COOKIE_NAME } from '@/lib/auth/admin-auth';
import { GET as getOrderHandler } from '@/app/api/orders/[id]/route';
import { GET as listOrdersHandler } from '@/app/api/orders/route';
import { GET as getMetricsHandler } from '@/app/api/admin/metrics/route';

describe('Multi-Shop / Multi-Tenancy Isolation', () => {
  const repo = getRepository();

  const shopAId = DEFAULT_SHOP_ID;
  const shopBId = '00000000-0000-0000-0000-000000000002';

  beforeEach(async () => {
    if (repo.clear) {
      await repo.clear();
    }

    const shopB: Shop = {
      id: shopBId,
      name: 'PRINTOS Downtown Branch',
      slug: 'downtown-branch',
      phone: '+918888888888',
      address: 'Downtown Metro Station, Counter 4',
      currency: 'INR',
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await repo.createShop(shopB);
  });

  describe('Shop Entity & Discovery', () => {
    it('initializes the default shop and allows registering tenant shops', async () => {
      const defaultShop = await repo.getShop(shopAId);
      expect(defaultShop).toBeDefined();
      expect(defaultShop?.name).toContain('PRINTOS Flagship');

      const shopB = await repo.getShop(shopBId);
      expect(shopB).toBeDefined();
      expect(shopB?.name).toBe('PRINTOS Downtown Branch');

      const allShops = await repo.listShops();
      expect(allShops.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Order & Revenue Metric Tenant Isolation', () => {
    it('isolates orders and metrics strictly between Shop A and Shop B', async () => {
      const orderA: PrintOrder = {
        id: 'ord_shop_a_1',
        shopId: shopAId,
        orderNumber: 'P1001',
        customerPhone: '919800000001',
        status: 'PAID',
        originalFilename: 'docA.pdf',
        storagePath: 'orders/ord_shop_a_1/docA.pdf',
        fileType: 'pdf',
        fileSize: 1024,
        pageCount: 5,
        paperSize: 'A4',
        colorMode: 'BW',
        printSides: 'ONE_SIDED',
        copies: 1,
        selectedPageCount: 5,
        subtotalPaisa: 1000,
        discountPaisa: 0,
        totalAmountPaisa: 1000,
        currency: 'INR',
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString(),
      };

      const orderB: PrintOrder = {
        id: 'ord_shop_b_1',
        shopId: shopBId,
        orderNumber: 'P2001',
        customerPhone: '919800000002',
        status: 'PAID',
        originalFilename: 'docB.pdf',
        storagePath: 'orders/ord_shop_b_1/docB.pdf',
        fileType: 'pdf',
        fileSize: 2048,
        pageCount: 10,
        paperSize: 'A4',
        colorMode: 'COLOR',
        printSides: 'ONE_SIDED',
        copies: 2,
        selectedPageCount: 10,
        subtotalPaisa: 20000,
        discountPaisa: 0,
        totalAmountPaisa: 20000,
        currency: 'INR',
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString(),
      };

      await repo.createOrder(orderA);
      await repo.createOrder(orderB);

      // List orders by shopId
      const ordersA = await repo.listOrders({ shopId: shopAId });
      const ordersB = await repo.listOrders({ shopId: shopBId });

      expect(ordersA.some((o) => o.id === 'ord_shop_a_1')).toBe(true);
      expect(ordersA.some((o) => o.id === 'ord_shop_b_1')).toBe(false);

      expect(ordersB.some((o) => o.id === 'ord_shop_b_1')).toBe(true);
      expect(ordersB.some((o) => o.id === 'ord_shop_a_1')).toBe(false);

      // Metrics isolation
      const metricsA = await repo.getDashboardMetrics(shopAId);
      const metricsB = await repo.getDashboardMetrics(shopBId);

      expect(metricsA.todayOrders).toBe(1);
      expect(metricsA.revenuePaisa).toBe(1000);

      expect(metricsB.todayOrders).toBe(1);
      expect(metricsB.revenuePaisa).toBe(20000);
    });
  });

  describe('Print Queue & Atomic Claiming Tenant Isolation', () => {
    it('prevents agent in Shop A from claiming queued jobs in Shop B', async () => {
      // 1. Create order and queued job for Shop B
      const orderB: PrintOrder = {
        id: 'ord_shop_b_queue',
        shopId: shopBId,
        orderNumber: 'P2002',
        customerPhone: '919800000099',
        status: 'AWAITING_PAYMENT',
        originalFilename: 'docB_queue.pdf',
        storagePath: 'orders/ord_shop_b_queue/docB_queue.pdf',
        fileType: 'pdf',
        fileSize: 1024,
        pageCount: 2,
        paperSize: 'A4',
        colorMode: 'BW',
        printSides: 'ONE_SIDED',
        copies: 1,
        selectedPageCount: 2,
        subtotalPaisa: 400,
        discountPaisa: 0,
        totalAmountPaisa: 400,
        currency: 'INR',
        paymentStatus: 'PENDING',
        createdAt: new Date().toISOString(),
      };
      await repo.createOrder(orderB);
      await repo.simulateVerifiedPayment(orderB.id, 'tx_b_100', 'UPI_QR');

      // 2. Shop A agent attempts to claim next job
      const claimedByShopA = await repo.claimNextPrintJob('agent_shop_a', undefined, shopAId);
      expect(claimedByShopA).toBeNull();

      // 3. Shop B agent attempts to claim next job
      const claimedByShopB = await repo.claimNextPrintJob('agent_shop_b', undefined, shopBId);
      expect(claimedByShopB).toBeDefined();
      expect(claimedByShopB?.orderId).toBe('ord_shop_b_queue');
      expect(claimedByShopB?.orderNumber).toBe('P2002');
    });
  });

  describe('Admin Portal & Route Isolation', () => {
    it('prevents Shop A admin token from reading Shop B order details', async () => {
      const orderB: PrintOrder = {
        id: 'ord_shop_b_secret',
        shopId: shopBId,
        orderNumber: 'P2003',
        customerPhone: '919800000077',
        status: 'RECEIVED',
        originalFilename: 'secret.pdf',
        storagePath: 'orders/ord_shop_b_secret/secret.pdf',
        fileType: 'pdf',
        fileSize: 1024,
        pageCount: 1,
        paperSize: 'A4',
        colorMode: 'BW',
        printSides: 'ONE_SIDED',
        copies: 1,
        selectedPageCount: 1,
        subtotalPaisa: 200,
        discountPaisa: 0,
        totalAmountPaisa: 200,
        currency: 'INR',
        paymentStatus: 'PENDING',
        createdAt: new Date().toISOString(),
      };
      await repo.createOrder(orderB);

      // Create Admin Token for Shop A
      const tokenShopA = await createAdminToken({
        id: 'admin_a',
        email: 'staff_a@shop.com',
        role: 'admin',
        shopId: shopAId,
      });

      const req = new NextRequest(`http://localhost:3000/api/orders/${orderB.id}`, {
        headers: { cookie: `${ADMIN_COOKIE_NAME}=${tokenShopA}` },
      });

      const res = await getOrderHandler(req, { params: { id: orderB.id } });
      expect(res.status).toBe(404);
    });

    it('returns only tenant-scoped metrics and orders in admin endpoints', async () => {
      const orderB: PrintOrder = {
        id: 'ord_shop_b_admin',
        shopId: shopBId,
        orderNumber: 'P2004',
        customerPhone: '919800000088',
        status: 'COMPLETED',
        originalFilename: 'b_admin.pdf',
        storagePath: 'orders/ord_shop_b_admin/b_admin.pdf',
        fileType: 'pdf',
        fileSize: 1024,
        pageCount: 3,
        paperSize: 'A4',
        colorMode: 'BW',
        printSides: 'ONE_SIDED',
        copies: 1,
        selectedPageCount: 3,
        subtotalPaisa: 600,
        discountPaisa: 0,
        totalAmountPaisa: 600,
        currency: 'INR',
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString(),
      };
      await repo.createOrder(orderB);

      const tokenShopB = await createAdminToken({
        id: 'admin_b',
        email: 'manager@shop-b.com',
        role: 'admin',
        shopId: shopBId,
      });

      const req = new NextRequest('http://localhost:3000/api/admin/metrics', {
        headers: { cookie: `${ADMIN_COOKIE_NAME}=${tokenShopB}` },
      });

      const res = await getMetricsHandler(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.shop.id).toBe(shopBId);
      expect(data.shop.name).toBe('PRINTOS Downtown Branch');
      expect(data.orders.length).toBe(1);
      expect(data.orders[0].id).toBe('ord_shop_b_admin');
    });
  });
});
