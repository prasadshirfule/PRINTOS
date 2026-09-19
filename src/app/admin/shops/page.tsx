'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Store,
  Plus,
  Edit2,
  CheckCircle2,
  XCircle,
  Phone,
  MapPin,
  Printer as PrinterIcon,
  ShoppingBag,
  Clock,
  IndianRupee,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { Shop } from '@/types/printos';

interface EnrichedShop extends Shop {
  stats?: {
    ordersCount: number;
    printersCount: number;
    onlinePrintersCount: number;
    todayOrders: number;
    activeQueue: number;
    revenuePaisa: number;
    pagesPrinted: number;
  };
}

export default function AdminShopsPage() {
  const [shops, setShops] = useState<EnrichedShop[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Modal states
  const [editingShop, setEditingShop] = useState<EnrichedShop | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form states
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formCurrency, setFormCurrency] = useState('INR');
  const [formIsActive, setFormIsActive] = useState(true);

  const fetchShops = async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    try {
      const res = await fetch('/api/admin/shops');
      if (!res.ok) {
        throw new Error('Failed to load shops');
      }
      const data = await res.json();
      setShops(data.shops || []);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error fetching shops');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchShops();
  }, []);

  const openEditModal = (shop: EnrichedShop) => {
    setEditingShop(shop);
    setFormName(shop.name);
    setFormSlug(shop.slug);
    setFormPhone(shop.phone || '');
    setFormAddress(shop.address || '');
    setFormCurrency(shop.currency || 'INR');
    setFormIsActive(shop.isActive);
    setIsCreating(false);
  };

  const openCreateModal = () => {
    setEditingShop(null);
    setFormName('');
    setFormSlug('');
    setFormPhone('');
    setFormAddress('');
    setFormCurrency('INR');
    setFormIsActive(true);
    setIsCreating(true);
  };

  const closeModal = () => {
    setEditingShop(null);
    setIsCreating(false);
    setSubmitting(false);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      alert('Please enter a shop name');
      return;
    }

    setSubmitting(true);
    try {
      if (isCreating) {
        const res = await fetch('/api/admin/shops', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: formName.trim(),
            slug: formSlug.trim() || undefined,
            phone: formPhone.trim() || null,
            address: formAddress.trim() || null,
            currency: formCurrency.trim().toUpperCase() || 'INR',
            isActive: formIsActive,
          }),
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Failed to create shop');
        }

        setSuccessMessage('Shop created successfully!');
      } else if (editingShop) {
        const res = await fetch(`/api/admin/shops/${editingShop.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: formName.trim(),
            slug: formSlug.trim() || undefined,
            phone: formPhone.trim() || null,
            address: formAddress.trim() || null,
            currency: formCurrency.trim().toUpperCase() || 'INR',
            isActive: formIsActive,
          }),
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Failed to update shop');
        }

        setSuccessMessage(`Shop "${formName}" updated successfully!`);
      }

      closeModal();
      await fetchShops();
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Operation failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && shops.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="flex items-center space-x-3 text-slate-500">
          <RefreshCw className="h-5 w-5 animate-spin" />
          <span>Loading shop locations and metrics...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 flex items-center space-x-2">
            <Store className="h-6 w-6 text-blue-600" />
            <span>Shop Management</span>
          </h1>
          <p className="text-sm text-slate-500">
            View, configure, and monitor multi-tenant print shop branches and hardware isolation.
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => fetchShops(true)}
            disabled={refreshing}
            className="flex items-center space-x-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={openCreateModal}
            className="flex items-center space-x-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 transition"
          >
            <Plus className="h-4 w-4" />
            <span>Add New Shop</span>
          </button>
        </div>
      </div>

      {/* Success Notification Banner */}
      {successMessage && (
        <div className="flex items-center space-x-2 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 animate-fade-in">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div className="flex items-center space-x-2 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          <XCircle className="h-4 w-4 text-red-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Shop Cards Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {shops.map((shop) => {
          const stats = shop.stats || {
            ordersCount: 0,
            printersCount: 0,
            onlinePrintersCount: 0,
            todayOrders: 0,
            activeQueue: 0,
            revenuePaisa: 0,
            pagesPrinted: 0,
          };
          const revenueRupees = (stats.revenuePaisa / 100).toFixed(2);

          return (
            <div
              key={shop.id}
              className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md"
            >
              <div className="p-6">
                {/* Shop Title & Status */}
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center space-x-2">
                      <h2 className="text-lg font-bold text-slate-900">{shop.name}</h2>
                      <span
                        className={`inline-flex items-center space-x-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                          shop.isActive
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-slate-100 text-slate-600 border border-slate-200'
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            shop.isActive ? 'bg-emerald-500' : 'bg-slate-400'
                          }`}
                        />
                        <span>{shop.isActive ? 'Active' : 'Inactive'}</span>
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 font-mono mt-0.5">slug: {shop.slug}</p>
                  </div>

                  <button
                    onClick={() => openEditModal(shop)}
                    className="flex items-center space-x-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-blue-600 transition"
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                    <span>Edit</span>
                  </button>
                </div>

                {/* Contact & Location Details */}
                <div className="mt-4 space-y-1.5 text-xs text-slate-600">
                  <div className="flex items-center space-x-2">
                    <Phone className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                    <span>{shop.phone || 'No phone configured'}</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <MapPin className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                    <span className="truncate">{shop.address || 'No physical address specified'}</span>
                  </div>
                </div>

                {/* Operational Metrics */}
                <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-lg bg-slate-50 p-3 border border-slate-100">
                    <div className="flex items-center space-x-1.5 text-xs text-slate-500">
                      <ShoppingBag className="h-3.5 w-3.5 text-blue-500" />
                      <span>Orders</span>
                    </div>
                    <p className="mt-1 text-base font-bold text-slate-900">{stats.ordersCount}</p>
                  </div>

                  <div className="rounded-lg bg-slate-50 p-3 border border-slate-100">
                    <div className="flex items-center space-x-1.5 text-xs text-slate-500">
                      <PrinterIcon className="h-3.5 w-3.5 text-emerald-500" />
                      <span>Printers</span>
                    </div>
                    <p className="mt-1 text-base font-bold text-slate-900">
                      {stats.onlinePrintersCount} / {stats.printersCount}{' '}
                      <span className="text-xs font-normal text-slate-500">Online</span>
                    </p>
                  </div>

                  <div className="rounded-lg bg-slate-50 p-3 border border-slate-100">
                    <div className="flex items-center space-x-1.5 text-xs text-slate-500">
                      <Clock className="h-3.5 w-3.5 text-amber-500" />
                      <span>Queue</span>
                    </div>
                    <p className="mt-1 text-base font-bold text-slate-900">{stats.activeQueue}</p>
                  </div>

                  <div className="rounded-lg bg-slate-50 p-3 border border-slate-100">
                    <div className="flex items-center space-x-1.5 text-xs text-slate-500">
                      <IndianRupee className="h-3.5 w-3.5 text-purple-500" />
                      <span>Revenue</span>
                    </div>
                    <p className="mt-1 text-base font-bold text-slate-900">₹{revenueRupees}</p>
                  </div>
                </div>
              </div>

              {/* Card Footer with Quick Links */}
              <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/50 px-6 py-3 text-xs text-slate-500">
                <span className="font-mono text-[10px] text-slate-400 truncate max-w-[200px]">
                  ID: {shop.id}
                </span>
                <div className="flex items-center space-x-3">
                  <Link
                    href="/admin/printers"
                    className="font-medium text-slate-600 hover:text-blue-600 flex items-center space-x-1"
                  >
                    <span>Hardware</span>
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                  <Link
                    href="/admin/orders"
                    className="font-medium text-slate-600 hover:text-blue-600 flex items-center space-x-1"
                  >
                    <span>Orders</span>
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modal for Creating or Editing a Shop */}
      {(isCreating || editingShop) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl border border-slate-200">
            <h3 className="text-lg font-bold text-slate-900">
              {isCreating ? 'Create New Shop Branch' : `Edit Shop: ${editingShop?.name}`}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Configure tenant branch settings and contact information.
            </p>

            <form onSubmit={handleFormSubmit} className="mt-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700">Shop Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. PRINTOS Downtown Branch"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">URL Slug / Identifier</label>
                <input
                  type="text"
                  placeholder="e.g. downtown-branch"
                  value={formSlug}
                  onChange={(e) => setFormSlug(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">Support / Counter Phone</label>
                <input
                  type="text"
                  placeholder="e.g. +91 98765 43210"
                  value={formPhone}
                  onChange={(e) => setFormPhone(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">Physical Address</label>
                <textarea
                  rows={2}
                  placeholder="e.g. Shop #4, Student Plaza, University Road"
                  value={formAddress}
                  onChange={(e) => setFormAddress(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Currency</label>
                  <input
                    type="text"
                    value={formCurrency}
                    onChange={(e) => setFormCurrency(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono uppercase"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700">Status</label>
                  <select
                    value={formIsActive ? 'active' : 'inactive'}
                    onChange={(e) => setFormIsActive(e.target.value === 'active')}
                    className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="active">Active (Online)</option>
                    <option value="inactive">Inactive (Disabled)</option>
                  </select>
                </div>
              </div>

              <div className="mt-6 flex items-center justify-end space-x-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={submitting}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex items-center space-x-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 transition disabled:opacity-50"
                >
                  {submitting && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                  <span>{isCreating ? 'Create Shop' : 'Save Changes'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
