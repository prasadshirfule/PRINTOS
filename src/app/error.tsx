'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function GlobalErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log unexpected errors for production telemetry
    console.error('[PRINTOS Global Error]:', error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-6 text-center bg-slate-50">
      <div className="max-w-md rounded-2xl bg-white p-8 shadow-xl border border-rose-100">
        <div className="mb-4 inline-flex items-center justify-center rounded-full bg-rose-100 p-3 text-rose-600">
          <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Application Error</h1>
        <p className="mt-2 text-sm text-slate-600">
          {error.message || 'An unexpected error occurred while processing your request.'}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={() => reset()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-500"
          >
            Try Again
          </button>
          <Link
            href="/admin"
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
