import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';
import { calculatePrintOrderPrice } from '@/lib/pricing/pricing-engine';
import { PrintOrder, PaperSize, ColorMode, PrintSides, FileType } from '@/types/printos';
import { verifyAdminAuth } from '@/lib/auth/admin-auth';

export async function GET(req: NextRequest) {
  const auth = await verifyAdminAuth(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
  }

  const repo = getRepository();
  const orders = await repo.listOrders();
  return NextResponse.json({ orders });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      customerPhone,
      customerName,
      originalFilename = 'document.pdf',
      fileType = 'pdf',
      fileSize = 1048576,
      pageCount = 1,
      paperSize = 'A4',
      colorMode = 'BW',
      printSides = 'ONE_SIDED',
      copies = 1,
      pageSelection,
    } = body;

    if (!customerPhone) {
      return NextResponse.json({ error: 'customerPhone is required' }, { status: 400 });
    }

    // Deterministic price calculation strictly enforced server-side
    const priceBreakdown = calculatePrintOrderPrice({
      paperSize: paperSize as PaperSize,
      colorMode: colorMode as ColorMode,
      printSides: printSides as PrintSides,
      copies: Number(copies),
      totalDocumentPages: Number(pageCount),
      pageSelection,
    });

    const repo = getRepository();
    const orderId = crypto.randomUUID();
    const orderNumber = `P${Math.floor(1000 + Math.random() * 9000)}`;

    const order: PrintOrder = {
      id: orderId,
      orderNumber,
      customerPhone,
      customerName,
      status: 'AWAITING_PAYMENT',
      originalFilename,
      storagePath: `orders/${orderId}/${originalFilename}`,
      fileType: fileType as FileType,
      fileSize: Number(fileSize),
      pageCount: Number(pageCount),
      paperSize: paperSize as PaperSize,
      colorMode: colorMode as ColorMode,
      printSides: printSides as PrintSides,
      copies: Number(copies),
      pageSelection: pageSelection || null,
      selectedPageCount: priceBreakdown.printablePages,
      subtotalPaisa: priceBreakdown.subtotalPaisa,
      discountPaisa: priceBreakdown.discountPaisa,
      totalAmountPaisa: priceBreakdown.totalAmountPaisa,
      currency: 'INR',
      paymentStatus: 'PENDING',
      createdAt: new Date().toISOString(),
    };

    await repo.createOrder(order);
    await repo.recordOrderEvent(order.id, 'OPTIONS_SELECTED', 'Customer configured print options', {
      ...priceBreakdown,
    });
    await repo.recordOrderEvent(order.id, 'PRICE_CALCULATED', `Total price: ${priceBreakdown.totalAmountFormatted}`, {
      totalAmountPaisa: priceBreakdown.totalAmountPaisa,
    });

    return NextResponse.json({
      ok: true,
      order,
      priceBreakdown,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create order' },
      { status: 400 }
    );
  }
}