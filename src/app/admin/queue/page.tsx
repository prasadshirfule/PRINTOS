'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PrintJob, PrintOrder } from '@/types/printos';

export default function AdminQueuePage() {
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [orders, setOrders] = useState<Record<string, PrintOrder>>({});
  const [loading, setLoading] = useState(true);

  const fetchQueueData = async () => {
    try {
      const res = await fetch('/api/admin/metrics');
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs || []);
        const orderMap: Record<string, PrintOrder> = {};
        (data.orders || []).forEach((o: PrintOrder) => {
          orderMap[o.id] = o;
        });
        setOrders(orderMap);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchQueueData();
    const interval = setInterval(fetchQueueData, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Active Print Queue</h1>
          <p className="text-sm text-slate-500">
            Real-time FIFO priority queue consumed atomically by shop Print Agents.
          </p>
        </div>
        <div className="flex items-center space-x-2 text-xs text-slate-500 bg-white border border-slate-200 px-3 py-1.5 rounded-lg">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
          <span>Live Queue Stream</span>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-6 py-3 font-semibold">Order</th>
                <th className="px-6 py-3 font-semibold">Customer</th>
                <th className="px-6 py-3 font-semibold">File</th>
                <th className="px-6 py-3 font-semibold">Pages</th>
                <th className="px-6 py-3 font-semibold">Options</th>
                <th className="px-6 py-3 font-semibold">Amount</th>
                <th className="px-6 py-3 font-semibold">Attempts</th>
                <th className="px-6 py-3 font-semibold">Status</th>
                <th className="px-6 py-3 font-semibold">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-6 py-8 text-center text-slate-400">Loading queue...</td>
                </tr>
              ) : jobs.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-8 text-center text-slate-400">
                    Queue is currently empty.
                  </td>
                </tr>
              ) : (
                jobs.map((job) => {
                  const order = orders[job.orderId];
                  return (
                    <tr key={job.id} className="hover:bg-slate-50">
                      <td className="px-6 py-4 font-mono font-medium text-blue-600">
                        {order ? (
                          <Link href={`/admin/orders/${order.id}`} className="hover:underline">
                            #{order.orderNumber}
                          </Link>
                        ) : (
                          job.id.substring(0, 8)
                        )}
                      </td>
                      <td className="px-6 py-4 text-slate-700">
                        <div>{order?.customerName || 'Customer'}</div>
                        <div className="text-xs text-slate-400">{order?.customerPhone || '—'}</div>
                      </td>
                      <td className="px-6 py-4 text-slate-900 font-medium truncate max-w-xs">
                        {order?.originalFilename || 'document.pdf'}
                      </td>
                      <td className="px-6 py-4 text-slate-600">
                        {order?.selectedPageCount || 1} pgs
                      </td>
                      <td className="px-6 py-4 text-xs text-slate-600">
                        {order ? `${order.colorMode} / ${order.paperSize} / ${order.printSides} / ${order.copies}x` : '—'}
                      </td>
                      <td className="px-6 py-4 font-semibold text-slate-900">
                        {order ? `₹${(order.totalAmountPaisa / 100).toFixed(2)}` : '—'}
                      </td>
                      <td className="px-6 py-4 text-xs text-slate-500 font-mono">
                        {job.attemptCount}/{job.maxAttempts}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                            job.status === 'COMPLETED'
                              ? 'bg-emerald-100 text-emerald-800'
                              : job.status === 'PRINTING' || job.status === 'CLAIMED'
                              ? 'bg-blue-100 text-blue-800 animate-pulse'
                              : job.status === 'QUEUED'
                              ? 'bg-amber-100 text-amber-800'
                              : job.status === 'FAILED'
                              ? 'bg-rose-100 text-rose-800'
                              : 'bg-slate-100 text-slate-800'
                          }`}
                        >
                          {job.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-xs text-slate-400">
                        {new Date(job.createdAt).toLocaleTimeString()}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
