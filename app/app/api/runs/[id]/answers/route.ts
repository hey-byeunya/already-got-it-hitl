import { NextResponse } from 'next/server';
import * as store from '@/lib/store';

export const runtime = 'nodejs';

/**
 * 질문 답변 제출.
 *
 * 지난 버전 질문에 뒤늦게 답이 오면 거절한다 — 현재 작업을 덮어쓰지 않는다.
 * 같은 답변을 두 번 제출해도 작업이 두 번 돌지 않는다 (already_answered).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({})) as
    { question_id?: string; version?: number; answers?: Record<string, string> };

  if (!body.question_id || typeof body.version !== 'number' || !body.answers) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const r = store.submitAnswer(id, body.question_id, body.version, body.answers);
  if (r.ok) return NextResponse.json({ ok: true });

  const status = r.error === 'run_not_found' ? 404 : 409;
  return NextResponse.json(r, { status });
}
