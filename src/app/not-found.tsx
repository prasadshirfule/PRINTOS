import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 text-center bg-slate-50">
      <div className="max-w-md rounded-2xl bg-white p-8 shadow-xl border border-slate-200">
        <div className="mb-4 inline-flex items-center justify-center rounded-full bg-amber-100 p-3 text-amber-600">
          <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Page Not Found</h1>
        <p className="mt-2 text-sm text-slate-600">
          The page or resource you are looking for does not exist or has been moved.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            href="/admin"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-500"
          >
            Go to Admin Dashboard
          </Link>
          <Link
            href="/"
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Home
          </Link>
        </div>
      </div>
    </main>
  );
}
