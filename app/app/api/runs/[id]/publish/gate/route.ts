import { NextResponse } from 'next/server';
import { gateRun, type PublishError } from '@/lib/publish';

export const runtime = 'nodejs';

const STATUS: Partial<Record<PublishError, number>> = { run_not_found: 404, no_publish: 404 };

/**
 * 발행 게이트를 돌린다.
 *   - 처음이면 판정한다. 걸리면 대기, 안 걸리면 곧바로 보낸다
 *   - 이미 대기 중이거나 다시 판정 중이면 지금 카드로 **다시 판정**한다 (여전히 사람 확인 대기)
 *   - 이미 승인·반려·발행된 건은 거절한다 — 같은 실행을 두 번 보내지 않는다
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await gateRun(id, { regate: true });
  if (!r.ok) return NextResponse.json({ error: r.error, message: r.message }, { status: STATUS[r.error] ?? 409 });
  return NextResponse.json({ ok: true, publish: r.state });
}
