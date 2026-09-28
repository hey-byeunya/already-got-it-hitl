import { NextResponse } from 'next/server';
import * as store from '@/lib/store';
import { start } from '@/lib/runner';

export const runtime = 'nodejs';

/**
 * 중단된 실행을 재개하거나 재시도한다.
 *
 * 서버가 재시작되면 메모리에서 기다리던 콜백이 사라진다. 상태만 고쳐도 작업은 이어지지 않으므로,
 * 저장한 세션 ID 와 맥락으로 **다시 시작**한다 (API_SPEC.md 「새로고침과 서버 재시작」).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({})) as { mode?: 'resume' | 'retry' };
  const mode = body.mode ?? 'resume';

  const s = store.readState(id);
  if (!s) return NextResponse.json({ error: 'run_not_found' }, { status: 404 });
  if (s.live) {
    return NextResponse.json({ error: 'already_live', message: '이 실행은 지금 돌고 있다' }, { status: 409 });
  }
  if (mode === 'resume' && !s.session_id) {
    return NextResponse.json(
      { error: 'no_session_to_resume',
        message: '이어갈 세션 ID 가 없다. 재시도(retry)로 처음부터 다시 돌린다' },
      { status: 409 },
    );
  }

  store.update(id, (st) => {
    // 대기 중이던 질문·승인은 콜백이 사라져 유효하지 않다. 다시 물어야 한다.
    st.pending_question = null;
    st.pending_approval = null;
    st.trace.push({ seq: st.trace.length + 1, at: new Date().toISOString(), kind: 'resume',
      label: mode === 'resume' ? '재개 - 저장한 세션으로 이어간다' : '재시도 - 처음부터 다시 돌린다',
      detail: mode === 'resume' ? `session_id: ${st.session_id}` : undefined });
  });

  start({
    runId: id,
    fixtureId: s.fixture_id,
    goal: s.goal,
    ...(mode === 'resume' && s.session_id ? { resumeSessionId: s.session_id } : {}),
  });
  return NextResponse.json({ ok: true, mode });
}
