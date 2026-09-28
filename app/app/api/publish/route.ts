import { NextResponse } from 'next/server';
import { listQueue, publishDryRun } from '@/lib/publish';

export const runtime = 'nodejs';

/** 발행 대기 목록. 사람의 답을 기다리는 것이 먼저 온다. */
export async function GET() {
  const rows = await listQueue();
  // 다시 판정 중인 에이전트가 사람에게 묻고 있는 것도 사람이 답할 일이다.
  const waiting = rows.filter((r) => r.status === 'pending_review' || r.status === 'send_failed'
    || (r.status === 'retrying' && r.waiting_question)).length;
  return NextResponse.json({ rows, waiting, dry_run: publishDryRun() });
}
