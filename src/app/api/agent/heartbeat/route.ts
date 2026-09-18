import { NextRequest, NextResponse } from 'next/server';
import { globalStore } from '@/lib/db/store';

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get('x-agent-key') || req.headers.get('authorization')?.replace('Bearer ', '');
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing agent authentication token' }, { status: 401 });
    }

    const agent = globalStore.authenticateAgent(apiKey);
    if (!agent) {
      return NextResponse.json({ error: 'Invalid agent token' }, { status: 403 });
    }

    const body = await req.json();
    const { agentName = agent.agentName, printerStatus = 'ONLINE', capabilities, version = '1.0.0' } = body;

    const updatedAgent = globalStore.recordAgentHeartbeat(agentName, printerStatus, capabilities, version);

    return NextResponse.json({
      ok: true,
      agent: {
        id: updatedAgent.id,
        name: updatedAgent.agentName,
        status: updatedAgent.status,
        lastSeenAt: updatedAgent.lastSeenAt,
      },
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Heartbeat failure' },
      { status: 500 }
    );
  }
}
