'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PrintOrder, PrintJob, PrintOrderEvent } from '@/types/printos';
import { formatCustomerContact } from '@/lib/utils/phone-formatter';

export default function OrderDetailsPage() {
  const params = useParams();
  const orderId = params?.id as string;

  const [order, setOrder] = useState<PrintOrder | null>(null);
  const [job, setJob] = useState<PrintJob | null>(null);
  const [events, setEvents] = useState<PrintOrderEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);

  const fetchOrderData = useCallback(async () => {
    if (!orderId) return;
    try {
      const res = await fetch(`/api/orders/${orderId}`);
      if (res.ok) {
        const data = await res.json();
        setOrder(data.order);
        setJob(data.job);
        setEvents(data.events || []);
      }
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    fetchOrderData();
    const interval = setInterval(fetchOrderData, 2000);
    return () => clearInterval(interval);
  }, [fetchOrderData]);

  const handleSimulatePayment = async () => {
    setPaying(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/simulate-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'UPI_QR' }),
      });
      if (!res.ok) throw new Error('Payment simulation failed');
      await fetchOrderData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Error simulating payment');
    } finally {
      setPaying(false);
    }
  };

  if (loading && !order) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-slate-500">Loading order #{orderId}...</p>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="space-y-4">
        <Link href="/admin/orders" className="text-sm font-semibold text-blue-600">
          ← Back to Orders
        </Link>
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-700">
          Order not found.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center space-x-3">
            <Link href="/admin/orders" className="text-sm font-semibold text-slate-500 hover:text-slate-800">
              ← Orders
            </Link>
            <span className="text-slate-300">/</span>
            <h1 className="text-2xl font-bold text-slate-900">Order #{order.orderNumber}</h1>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                order.status === 'COMPLETED'
                  ? 'bg-emerald-100 text-emerald-800'
                  : order.status === 'PRINTING'
                  ? 'bg-blue-100 text-blue-800 animate-pulse'
                  : order.status === 'QUEUED'
                  ? 'bg-amber-100 text-amber-800'
                  : order.status === 'AWAITING_PAYMENT'
                  ? 'bg-purple-100 text-purple-800'
                  : 'bg-slate-100 text-slate-800'
              }`}
            >
              {order.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">Created: {new Date(order.createdAt).toLocaleString()}</p>
        </div>

        {order.status === 'AWAITING_PAYMENT' && (
          <button
            onClick={handleSimulatePayment}
            disabled={paying}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-500 disabled:opacity-50"
          >
            {paying ? 'Processing...' : 'Simulate UPI Payment (₹' + (order.totalAmountPaisa / 100).toFixed(2) + ')'}
          </button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left 2 Cols: Order & Job Details */}
        <div className="space-y-6 lg:col-span-2">
          {/* Document & Print Configuration */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
            <h2 className="text-base font-semibold text-slate-900 border-b border-slate-100 pb-3">
              Document & Print Specifications
            </h2>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-xs text-slate-400 block">Filename</span>
                <span className="font-medium text-slate-800">{order.originalFilename}</span>
              </div>
              <div>
                <span className="text-xs text-slate-400 block">File Type & Size</span>
                <span className="font-medium text-slate-800">
                  {order.fileType.toUpperCase()} • {(order.fileSize / 1024).toFixed(1)} KB
                </span>
              </div>
              <div>
                <span className="text-xs text-slate-400 block">Colour Mode</span>
                <span className="font-medium text-slate-800">{order.colorMode === 'COLOR' ? '🎨 Colour' : '⚫ Black & White'}</span>
              </div>
              <div>
                <span className="text-xs text-slate-400 block">Paper Size</span>
                <span className="font-medium text-slate-800">{order.paperSize}</span>
              </div>
              <div>
                <span className="text-xs text-slate-400 block">Print Sides</span>
                <span className="font-medium text-slate-800">{order.printSides === 'BOTH_SIDES' ? '↔️ Both Sides (Duplex)' : 'One Sided'}</span>
              </div>
              <div>
                <span className="text-xs text-slate-400 block">Copies</span>
                <span className="font-medium text-slate-800">{order.copies}</span>
              </div>
              <div>
                <span className="text-xs text-slate-400 block">Pages</span>
                <span className="font-medium text-slate-800">
                  {order.selectedPageCount} of {order.pageCount} ({order.pageSelection || 'All'})
                </span>
              </div>
              <div>
                <span className="text-xs text-slate-400 block">Total Printable Impressions</span>
                <span className="font-medium text-slate-800">{order.selectedPageCount * order.copies} pages</span>
              </div>
            </div>
          </div>

          {/* Print Job Status */}
          {job && (
            <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
              <h2 className="text-base font-semibold text-slate-900 border-b border-slate-100 pb-3">
                Print Queue Job Details
              </h2>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-xs text-slate-400 block">Job ID</span>
                  <span className="font-mono text-xs text-slate-800">{job.id}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400 block">Job Status</span>
                  <span className="font-semibold text-slate-800">{job.status}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400 block">Priority / Attempts</span>
                  <span className="font-medium text-slate-800">
                    Priority {job.priority} • Attempt {job.attemptCount} of {job.maxAttempts}
                  </span>
                </div>
                <div>
                  <span className="text-xs text-slate-400 block">Assigned Agent</span>
                  <span className="font-medium text-slate-800">{job.agentId || 'Awaiting Agent Claim'}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right Col: Customer & Payment & Audit Timeline */}
        <div className="space-y-6">
          {/* Customer & Financials */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
            <h2 className="text-base font-semibold text-slate-900 border-b border-slate-100 pb-3">
              Customer & Payment
            </h2>
            <div className="space-y-2 text-sm">
              <div>
                <span className="text-xs text-slate-400 block">Customer Contact</span>
                <span className="font-mono font-medium text-slate-800">{formatCustomerContact(order.customerPhone)}</span>
              </div>
              <div>
                <span className="text-xs text-slate-400 block">Payment Status</span>
                <span className="font-semibold text-slate-800">{order.paymentStatus}</span>
              </div>
              {order.paymentId && (
                <div>
                  <span className="text-xs text-slate-400 block">Transaction ID</span>
                  <span className="font-mono text-xs text-slate-800">{order.paymentId}</span>
                </div>
              )}
              <div className="border-t border-slate-100 pt-3 flex justify-between font-bold text-base text-slate-900">
                <span>Total Amount:</span>
                <span>₹{(order.totalAmountPaisa / 100).toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Audit Trail Timeline */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
            <h2 className="text-base font-semibold text-slate-900 border-b border-slate-100 pb-3">
              Audit Event Timeline
            </h2>
            <div className="space-y-4">
              {events.map((ev) => (
                <div key={ev.id} className="relative pl-6 border-l-2 border-slate-200 text-xs space-y-1">
                  <div className="absolute -left-[5px] top-1 h-2 w-2 rounded-full bg-blue-500" />
                  <div className="font-semibold text-slate-800">{ev.eventType}</div>
                  <div className="text-slate-600">{ev.message}</div>
                  <div className="text-slate-400 text-[10px]">
                    {new Date(ev.createdAt).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
