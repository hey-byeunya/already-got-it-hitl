import { NextResponse } from 'next/server';
import * as store from '@/lib/store';

export const runtime = 'nodejs';

/**
 * 쓰기 도구 승인·거절.
 *
 * 승인해도 이 라우트가 도구를 실행하지는 않는다 — 대기 중인 canUseTool 콜백을 풀어 주고,
 * 그 콜백이 1회용 토큰을 주입한다. 토큰 검사는 MCP 서버가 한다 (게이트 3겹).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({})) as
    { approval_id?: string; version?: number; approved?: boolean; reason?: string };

  if (!body.approval_id || typeof body.version !== 'number' || typeof body.approved !== 'boolean') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const r = store.submitApproval(id, body.approval_id, body.version, body.approved, body.reason);
  if (r.ok) return NextResponse.json({ ok: true });

  const status = r.error === 'run_not_found' ? 404 : 409;
  return NextResponse.json(r, { status });
}
