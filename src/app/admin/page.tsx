'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PrintOrder, Printer, PrintJob } from '@/types/printos';
import { formatCustomerContact } from '@/lib/utils/phone-formatter';

interface DashboardData {
  metrics: {
    todayOrders: number;
    queued: number;
    printing: number;
    completed: number;
    failed: number;
    revenuePaisa: number;
    pagesPrinted: number;
  };
  orders: PrintOrder[];
  jobs: PrintJob[];
  printers: Printer[];
}

export default function AdminDashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboardData = async () => {
    try {
      const res = await fetch('/api/admin/metrics');
      if (!res.ok) throw new Error('Failed to load metrics');
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error fetching dashboard data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleSimulateNewOrder = async () => {
    setCreatingOrder(true);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerPhone: `9198${Math.floor(10000000 + Math.random() * 90000000)}`,
          customerName: 'Test Student',
          originalFilename: 'assignment-final.pdf',
          fileType: 'pdf',
          fileSize: 2450000,
          pageCount: 12,
          paperSize: 'A4',
          colorMode: 'BW',
          printSides: 'BOTH_SIDES',
          copies: 2,
          pageSelection: '1-12',
        }),
      });

      if (!res.ok) throw new Error('Failed to create order');
      await fetchDashboardData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Error creating order');
    } finally {
      setCreatingOrder(false);
    }
  };

  const handleSimulatePayment = async (orderId: string) => {
    try {
      const res = await fetch(`/api/orders/${orderId}/simulate-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'UPI_QR' }),
      });
      if (!res.ok) throw new Error('Failed to simulate payment');
      await fetchDashboardData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Payment error');
    }
  };

  if (loading && !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-slate-500">Loading live dashboard metrics...</p>
      </div>
    );
  }

  const { metrics, orders = [], printers = [] } = data || {
    metrics: { todayOrders: 0, queued: 0, printing: 0, completed: 0, failed: 0, revenuePaisa: 0, pagesPrinted: 0 },
    orders: [],
    jobs: [],
    printers: [],
  };

  return (
    <div className="space-y-8">
      {/* Header with Quick Action */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Shop Command Center</h1>
          <p className="text-sm text-slate-500">
            Real-time status of orders, queue, and local printer hardware.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleSimulateNewOrder}
            disabled={creatingOrder}
            className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50"
          >
            {creatingOrder ? 'Creating...' : '+ Simulate Test Order (₹24)'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700 border border-red-200">
          {error}
        </div>
      )}

      {/* Metrics Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Today&apos;s Orders</p>
          <p className="mt-2 text-3xl font-bold text-slate-900">{metrics.todayOrders}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-amber-600 uppercase tracking-wider">Queued</p>
          <p className="mt-2 text-3xl font-bold text-amber-600">{metrics.queued}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-blue-600 uppercase tracking-wider">Printing</p>
          <p className="mt-2 text-3xl font-bold text-blue-600">{metrics.printing}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-emerald-600 uppercase tracking-wider">Completed</p>
          <p className="mt-2 text-3xl font-bold text-emerald-600">{metrics.completed}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-rose-600 uppercase tracking-wider">Failed</p>
          <p className="mt-2 text-3xl font-bold text-rose-600">{metrics.failed}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Revenue</p>
          <p className="mt-2 text-3xl font-bold text-slate-900">₹{(metrics.revenuePaisa / 100).toFixed(0)}</p>
        </div>
      </div>

      {/* Printer Status Banner */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Hardware & Agent Status</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {printers.map((printer) => (
            <div key={printer.id} className="flex items-center justify-between rounded-lg border border-slate-100 p-4 bg-slate-50">
              <div className="space-y-1">
                <div className="flex items-center space-x-2">
                  <span
                    className={`h-3 w-3 rounded-full ${
                      printer.status === 'ONLINE' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
                    }`}
                  />
                  <span className="font-medium text-slate-900">{printer.name}</span>
                </div>
                <p className="text-xs text-slate-500">Location: {printer.location}</p>
                <p className="text-xs text-slate-500">
                  Caps: {printer.supportsColor ? 'Color' : 'B&W'} • {printer.supportsDuplex ? 'Duplex' : 'Single-side'} • {printer.supportedPaperSizes.join(', ')}
                </p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  printer.status === 'ONLINE'
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-rose-100 text-rose-800'
                }`}
              >
                {printer.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Orders Table */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Recent Orders</h2>
          <Link href="/admin/orders" className="text-sm font-medium text-blue-600 hover:text-blue-500">
            View All Orders →
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-6 py-3 font-semibold">Order</th>
                <th className="px-6 py-3 font-semibold">Customer</th>
                <th className="px-6 py-3 font-semibold">Document</th>
                <th className="px-6 py-3 font-semibold">Options</th>
                <th className="px-6 py-3 font-semibold">Amount</th>
                <th className="px-6 py-3 font-semibold">Status</th>
                <th className="px-6 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-slate-400">
                    No orders placed yet. Click &ldquo;+ Simulate Test Order&rdquo; above.
                  </td>
                </tr>
              ) : (
                orders.slice(0, 8).map((order) => (
                  <tr key={order.id} className="hover:bg-slate-50">
                    <td className="px-6 py-4 font-mono font-medium text-slate-900">
                      <Link href={`/admin/orders/${order.id}`} className="hover:underline text-blue-600">
                        #{order.orderNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-slate-700">
                      <div>{order.customerName || 'Customer'}</div>
                      <div className="text-xs text-slate-400">{formatCustomerContact(order.customerPhone)}</div>
                    </td>
                    <td className="px-6 py-4 text-slate-700">
                      <div className="font-medium truncate max-w-xs">{order.originalFilename}</div>
                      <div className="text-xs text-slate-400">{order.pageCount} pages</div>
                    </td>
                    <td className="px-6 py-4 text-xs text-slate-600">
                      <span className="inline-block rounded bg-slate-100 px-2 py-0.5 mr-1 font-medium">
                        {order.colorMode}
                      </span>
                      <span className="inline-block rounded bg-slate-100 px-2 py-0.5 mr-1 font-medium">
                        {order.paperSize}
                      </span>
                      <span className="inline-block rounded bg-slate-100 px-2 py-0.5 mr-1 font-medium">
                        {order.printSides}
                      </span>
                      <span className="inline-block rounded bg-slate-100 px-2 py-0.5 font-medium">
                        {order.copies}x
                      </span>
                    </td>
                    <td className="px-6 py-4 font-semibold text-slate-900">
                      ₹{(order.totalAmountPaisa / 100).toFixed(2)}
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                          order.status === 'COMPLETED'
                            ? 'bg-emerald-100 text-emerald-800'
                            : order.status === 'PRINTING'
                            ? 'bg-blue-100 text-blue-800 animate-pulse'
                            : order.status === 'QUEUED'
                            ? 'bg-amber-100 text-amber-800'
                            : order.status === 'AWAITING_PAYMENT'
                            ? 'bg-purple-100 text-purple-800'
                            : order.status === 'FAILED'
                            ? 'bg-rose-100 text-rose-800'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {order.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      {order.status === 'AWAITING_PAYMENT' && (
                        <button
                          onClick={() => handleSimulatePayment(order.id)}
                          className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-500 shadow-sm"
                        >
                          Simulate Payment
                        </button>
                      )}
                      <Link
                        href={`/admin/orders/${order.id}`}
                        className="ml-2 text-xs font-medium text-slate-500 hover:text-slate-800"
                      >
                        Details →
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
