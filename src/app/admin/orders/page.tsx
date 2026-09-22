'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PrintOrder } from '@/types/printos';
import { formatCustomerContact } from '@/lib/utils/phone-formatter';

export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<PrintOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('ALL');

  const fetchOrders = async () => {
    try {
      const res = await fetch('/api/orders');
      if (res.ok) {
        const data = await res.json();
        setOrders(data.orders || []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 3000);
    return () => clearInterval(interval);
  }, []);

  const filteredOrders = orders.filter((o) => {
    if (filter === 'ALL') return true;
    return o.status === filter;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">All Print Orders</h1>
          <p className="text-sm text-slate-500">History and live state of customer print orders.</p>
        </div>
        <div className="flex gap-2">
          {['ALL', 'QUEUED', 'PRINTING', 'COMPLETED', 'AWAITING_PAYMENT', 'FAILED'].map((st) => (
            <button
              key={st}
              onClick={() => setFilter(st)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                filter === st
                  ? 'bg-slate-900 text-white'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-6 py-3 font-semibold">Order</th>
                <th className="px-6 py-3 font-semibold">Customer</th>
                <th className="px-6 py-3 font-semibold">Filename</th>
                <th className="px-6 py-3 font-semibold">Configuration</th>
                <th className="px-6 py-3 font-semibold">Total (₹)</th>
                <th className="px-6 py-3 font-semibold">Status</th>
                <th className="px-6 py-3 font-semibold">Created</th>
                <th className="px-6 py-3 font-semibold text-right">View</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-6 py-8 text-center text-slate-400">Loading orders...</td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-8 text-center text-slate-400">No orders found matching filter.</td>
                </tr>
              ) : (
                filteredOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50">
                    <td className="px-6 py-4 font-mono font-medium text-blue-600">
                      <Link href={`/admin/orders/${o.id}`} className="hover:underline">
                        #{o.orderNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-slate-700">
                      <div>{o.customerName || 'Customer'}</div>
                      <div className="text-xs text-slate-400">{formatCustomerContact(o.customerPhone)}</div>
                    </td>
                    <td className="px-6 py-4 font-medium text-slate-900 truncate max-w-xs">
                      {o.originalFilename}
                    </td>
                    <td className="px-6 py-4 text-xs text-slate-600">
                      {o.colorMode} • {o.paperSize} • {o.printSides} • {o.copies}x • {o.selectedPageCount} pgs
                    </td>
                    <td className="px-6 py-4 font-semibold text-slate-900">
                      ₹{(o.totalAmountPaisa / 100).toFixed(2)}
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex rounded-full px-2.5 py-1 text-xs font-semibold bg-slate-100 text-slate-800">
                        {o.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-xs text-slate-400">
                      {new Date(o.createdAt).toLocaleTimeString()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link href={`/admin/orders/${o.id}`} className="text-xs font-semibold text-blue-600 hover:text-blue-500">
                        View Details →
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
