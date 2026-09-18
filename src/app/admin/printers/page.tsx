'use client';

import { useEffect, useState } from 'react';
import { Printer } from '@/types/printos';

export default function AdminPrintersPage() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPrinters = async () => {
    try {
      const res = await fetch('/api/admin/metrics');
      if (res.ok) {
        const data = await res.json();
        setPrinters(data.printers || []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPrinters();
    const interval = setInterval(fetchPrinters, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Printers & Print Agents</h1>
        <p className="text-sm text-slate-500">
          Hardware monitoring and local Windows Print Agent connectivity status.
        </p>
      </div>

      <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4 text-sm text-blue-800">
        <strong>🔒 Security Notice:</strong> The cloud backend never directly accesses physical printer USB or local network ports.
        The local shop computer runs the isolated <code>print-agent</code> daemon which connects out via authenticated HTTPS.
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        {loading ? (
          <div className="p-8 text-center text-slate-400">Loading printer hardware status...</div>
        ) : printers.length === 0 ? (
          <div className="p-8 text-center text-slate-400">No printers registered.</div>
        ) : (
          printers.map((printer) => (
            <div key={printer.id} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                    🖨️
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-900">{printer.name}</h3>
                    <p className="text-xs text-slate-500">Location: {printer.location}</p>
                  </div>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    printer.status === 'ONLINE'
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-rose-100 text-rose-800'
                  }`}
                >
                  ● {printer.status}
                </span>
              </div>

              <div className="border-t border-slate-100 pt-4 grid grid-cols-2 gap-4 text-xs">
                <div>
                  <span className="text-slate-400 block">Colour Printing</span>
                  <span className="font-medium text-slate-700">{printer.supportsColor ? 'Supported (Yes)' : 'Monochrome Only'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Duplex (Both Sides)</span>
                  <span className="font-medium text-slate-700">{printer.supportsDuplex ? 'Supported (Yes)' : 'Single-Sided Only'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Supported Paper Sizes</span>
                  <span className="font-medium text-slate-700">{printer.supportedPaperSizes.join(', ')}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Last Heartbeat</span>
                  <span className="font-medium text-slate-700">
                    {printer.lastSeenAt ? new Date(printer.lastSeenAt).toLocaleTimeString() : 'Never'}
                  </span>
                </div>
              </div>

              <div className="border-t border-slate-100 pt-3 flex items-center justify-between text-xs text-slate-500">
                <span>Associated Agent: <code>shop-pc-01</code></span>
                <span className="text-emerald-600 font-medium">Ready for queue dispatch</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
