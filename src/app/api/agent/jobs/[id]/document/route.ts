import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  // In Phase 1 mock mode, returns a mock document download response or simulated content
  return new NextResponse('MOCK PDF CONTENT FOR TESTING PRINT QUEUE', {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="job-${params.id}.pdf"`,
    },
  });
}
