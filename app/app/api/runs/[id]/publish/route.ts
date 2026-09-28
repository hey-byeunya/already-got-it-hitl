import { NextResponse } from 'next/server';
import type { CardEdit, DecisionInput } from 'already-got-it-ops-agent/publish';
import * as store from '@/lib/store';
import { start } from '@/lib/runner';
import { decide, publishView, retryPrompt, settleOrphanRetry, type PublishError } from '@/lib/publish';

export const runtime = 'nodejs';

/**
 * 승인 화면이 보는 것 — 발행 상태, 걸린 기준(무엇을 보고 멈췄는지·막으려는 위험),
 * 판정에 쓴 운영 신호, 보낼 카드(고친 내용이 덮인 것), 보내면 어디로 가는지(DRY_RUN 여부).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!store.readState(id)) return NextResponse.json({ error: 'run_not_found' }, { status: 404 });
  await settleOrphanRetry(id);
  const view = publishView(id);
  if (!view) {
    return NextResponse.json({ error: 'no_publish', message: '아직 발행 게이트를 지나지 않았다' }, { status: 404 });
  }
  return NextResponse.json(view);
}

const STATUS: Partial<Record<PublishError, number>> = {
  run_not_found: 404, no_publish: 404,
  reason_required: 400, instruction_required: 400, edits_required: 400, all_cards_removed: 400,
};

function bad(message: string) {
  return NextResponse.json({ error: 'invalid_body', message }, { status: 400 });
}

/** 들어온 답을 검사해 DecisionInput 으로 만든다. 모양이 틀리면 이유를 돌려준다. */
function parse(b: Record<string, unknown>): DecisionInput | string {
  const version = b.version;
  if (typeof version !== 'number') return 'version 이 없다. 화면이 본 버전을 함께 보낸다';
  switch (b.action) {
    case 'approve': return { action: 'approve', version };
    case 'reject': return { action: 'reject', version, reason: typeof b.reason === 'string' ? b.reason : '' };
    case 'retry': return { action: 'retry', version, instruction: typeof b.instruction === 'string' ? b.instruction : '' };
    case 'edit': {
      if (!Array.isArray(b.edits)) return 'edits 가 없다';
      const edits: CardEdit[] = [];
      for (const e of b.edits as Record<string, unknown>[]) {
        if (typeof e?.card_no !== 'number') return 'edits 의 card_no 가 숫자가 아니다';
        if (e.title !== undefined && typeof e.title !== 'string') return 'title 은 문자열이다';
        if (e.body !== undefined && !(Array.isArray(e.body) && e.body.every((x) => typeof x === 'string'))) {
          return 'body 는 문자열 배열이다';
        }
        if (e.remove !== undefined && typeof e.remove !== 'boolean') return 'remove 는 true · false 다';
        edits.push({ card_no: e.card_no, ...(e.title !== undefined ? { title: e.title as string } : {}),
          ...(e.body !== undefined ? { body: e.body as string[] } : {}),
          ...(e.remove !== undefined ? { remove: e.remove as boolean } : {}) });
      }
      return { action: 'edit', version, edits };
    }
    default: return 'action 은 approve · edit · reject · retry 중 하나다';
  }
}

/**
 * 사람의 답 — 승인 · 수정 후 승인 · 반려(사유) · 다시 판정(지시).
 * 승인·수정은 곧바로 보내고, 다시 판정은 저장한 세션으로 에이전트를 이어 돌린다.
 * 다시 돈 실행이 끝나면 runner 가 afterRun 으로 다시 판정해 이 화면에 다시 올린다.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return bad('본문이 JSON 이 아니다');
  const d = parse(body);
  if (typeof d === 'string') return bad(d);

  const r = await decide(id, d);
  if (!r.ok) return NextResponse.json({ error: r.error, message: r.message }, { status: STATUS[r.error] ?? 409 });

  if (d.action === 'retry') {
    const run = store.readState(id)!;
    start({
      runId: id, fixtureId: run.fixture_id, goal: retryPrompt(d.instruction),
      resumeSessionId: run.session_id!,
    });
  }
  return NextResponse.json({ ok: true, publish: r.state });
}
