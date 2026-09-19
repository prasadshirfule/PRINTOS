import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getRepository, setRepository, InMemoryPrintOSRepository } from '@/lib/repository';
import { GET as listShopsRoute, POST as createShopRoute } from '@/app/api/admin/shops/route';
import { GET as getShopRoute, PATCH as updateShopRoute } from '@/app/api/admin/shops/[id]/route';
import { createAdminToken } from '@/lib/auth/admin-auth';
import { DEFAULT_SHOP_ID, Shop } from '@/types/printos';

describe('Shop Management & Multi-Tenancy UI Backend', () => {
  beforeEach(() => {
    setRepository(new InMemoryPrintOSRepository());
  });

  it('updates an existing shop via repository.updateShop', async () => {
    const repo = getRepository();
    const shop = await repo.getShop(DEFAULT_SHOP_ID);
    expect(shop).not.toBeNull();

    const updated = await repo.updateShop(DEFAULT_SHOP_ID, {
      name: 'PRINTOS Renovated Flagship',
      phone: '+91 99999 88888',
      address: 'Plot 42, Tech Hub',
    });

    expect(updated.name).toBe('PRINTOS Renovated Flagship');
    expect(updated.phone).toBe('+91 99999 88888');
    expect(updated.address).toBe('Plot 42, Tech Hub');

    const fetched = await repo.getShop(DEFAULT_SHOP_ID);
    expect(fetched?.name).toBe('PRINTOS Renovated Flagship');
  });

  it('lists shops with enriched statistics via /api/admin/shops GET', async () => {
    const token = await createAdminToken({
      id: 'admin_1',
      email: 'admin@printos.local',
      role: 'admin',
      shopId: DEFAULT_SHOP_ID,
    });

    const req = new NextRequest('http://localhost:3000/api/admin/shops', {
      headers: {
        cookie: `printos_admin_session=${token}`,
      },
    });

    const res = await listShopsRoute(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.shops).toBeDefined();
    expect(Array.isArray(data.shops)).toBe(true);
    expect(data.shops.length).toBeGreaterThan(0);

    const firstShop = data.shops[0];
    expect(firstShop.id).toBe(DEFAULT_SHOP_ID);
    expect(firstShop.stats).toBeDefined();
    expect(typeof firstShop.stats.ordersCount).toBe('number');
    expect(typeof firstShop.stats.printersCount).toBe('number');
  });

  it('creates a new shop via /api/admin/shops POST', async () => {
    const token = await createAdminToken({
      id: 'admin_1',
      email: 'admin@printos.local',
      role: 'admin',
      shopId: DEFAULT_SHOP_ID,
    });

    const req = new NextRequest('http://localhost:3000/api/admin/shops', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: `printos_admin_session=${token}`,
      },
      body: JSON.stringify({
        name: 'University Campus Branch',
        phone: '+91 98765 00000',
        address: 'Student Centre Block B',
        currency: 'INR',
        isActive: true,
      }),
    });

    const res = await createShopRoute(req);
    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data.shop).toBeDefined();
    expect(data.shop.name).toBe('University Campus Branch');
    expect(data.shop.slug).toBe('university-campus-branch');
    expect(data.shop.isActive).toBe(true);

    const repo = getRepository();
    const stored = await repo.getShop(data.shop.id);
    expect(stored?.name).toBe('University Campus Branch');
  });

  it('retrieves and updates a specific shop via /api/admin/shops/[id]', async () => {
    const token = await createAdminToken({
      id: 'admin_1',
      email: 'admin@printos.local',
      role: 'admin',
      shopId: DEFAULT_SHOP_ID,
    });

    // 1. GET shop details
    const getReq = new NextRequest(`http://localhost:3000/api/admin/shops/${DEFAULT_SHOP_ID}`, {
      headers: {
        cookie: `printos_admin_session=${token}`,
      },
    });

    const getRes = await getShopRoute(getReq, { params: { id: DEFAULT_SHOP_ID } });
    expect(getRes.status).toBe(200);
    const getData = await getRes.json();
    expect(getData.shop.id).toBe(DEFAULT_SHOP_ID);
    expect(getData.stats).toBeDefined();

    // 2. PATCH shop details
    const patchReq = new NextRequest(`http://localhost:3000/api/admin/shops/${DEFAULT_SHOP_ID}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        cookie: `printos_admin_session=${token}`,
      },
      body: JSON.stringify({
        name: 'Updated Flagship Store',
        phone: '+91 91111 22222',
        isActive: false,
      }),
    });

    const patchRes = await updateShopRoute(patchReq, { params: { id: DEFAULT_SHOP_ID } });
    expect(patchRes.status).toBe(200);
    const patchData = await patchRes.json();
    expect(patchData.shop.name).toBe('Updated Flagship Store');
    expect(patchData.shop.isActive).toBe(false);
  });

  it('enforces multi-tenancy access control on shop management routes', async () => {
    // Admin belongs to shop_other_tenant
    const tenantShopId = 'shop_tenant_branch_xyz';
    const otherShopId = 'shop_tenant_branch_abc';

    const repo = getRepository();
    await repo.createShop({
      id: tenantShopId,
      name: 'Tenant Shop XYZ',
      slug: 'tenant-xyz',
      currency: 'INR',
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const token = await createAdminToken({
      id: 'staff_xyz',
      email: 'staff@branchxyz.com',
      role: 'staff',
      shopId: tenantShopId,
    });

    // Attempt to update another shop (otherShopId)
    const patchReq = new NextRequest(`http://localhost:3000/api/admin/shops/${otherShopId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        cookie: `printos_admin_session=${token}`,
      },
      body: JSON.stringify({
        name: 'Malicious Name Override',
      }),
    });

    const patchRes = await updateShopRoute(patchReq, { params: { id: otherShopId } });
    expect(patchRes.status).toBe(403);
  });
});
