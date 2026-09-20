import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '@/lib/repository';
import { getStorageService, isSupabaseStorageConfigured } from '@/lib/storage/storage-service';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const apiKey = req.headers.get('x-agent-key') || req.headers.get('authorization')?.replace('Bearer ', '');
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing agent authentication token' }, { status: 401 });
    }

    const repo = getRepository();
    const agent = await repo.authenticateAgent(apiKey);
    if (!agent) {
      return NextResponse.json({ error: 'Invalid agent token' }, { status: 403 });
    }

    const jobId = params.id;
    const job = await repo.getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: 'Print job not found' }, { status: 404 });
    }

    // Strict Authorization: Agent must own this claimed job
    if (job.agentId !== agent.id) {
      return NextResponse.json(
        { error: 'Access denied: Document can only be accessed by the agent that claimed this job.' },
        { status: 403 }
      );
    }

    if (job.status !== 'CLAIMED' && job.status !== 'PRINTING') {
      return NextResponse.json(
        { error: `Document download not allowed for job in "${job.status}" state.` },
        { status: 400 }
      );
    }

    const order = await repo.getOrder(job.orderId);
    if (!order) {
      return NextResponse.json({ error: 'Order associated with job not found.' }, { status: 404 });
    }

    const hasSupabaseStorage = isSupabaseStorageConfigured();

    if (hasSupabaseStorage) {
      // Production: Generate short-lived signed URL from private Supabase Storage
      const storage = getStorageService();
      const signedUrl = await storage.createSignedUrl(order.storagePath, 300); // 5 minutes validity

      return NextResponse.json({
        downloadUrl: signedUrl,
        expiresInSeconds: 300,
        filename: order.originalFilename,
      });
    }

    // Development / Test fallback only: NEVER active in production
    if (process.env.NODE_ENV !== 'production') {
      return new NextResponse('MOCK SECURE PRINT DOCUMENT BUFFER', {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${order.originalFilename}"`,
        },
      });
    }

    // In production, reject if private storage is not configured
    return NextResponse.json(
      { error: 'Private storage service is not configured for production document download.' },
      { status: 500 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to retrieve document' },
      { status: 500 }
    );
  }
}