import { NextResponse } from 'next/server';
import { globalStore } from '@/lib/db/store';

export async function GET() {
  const metrics = globalStore.getDashboardMetrics();
  const orders = globalStore.listOrders();
  const jobs = globalStore.listJobs();
  const printers = globalStore.listPrinters();

  return NextResponse.json({
    metrics,
    orders,
    jobs,
    printers,
  });
}
