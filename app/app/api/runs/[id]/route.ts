import { NextResponse } from 'next/server';
import * as store from '@/lib/store';
import { readAxes, readCards, readExports, readLinks, steps } from '@/lib/derive';
import type { RunDetail } from '@/lib/types';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const state = store.readState(id);
  if (!state) return NextResponse.json({ error: 'run_not_found' }, { status: 404 });

  // 저장된 상태에 디스크에서 유도한 것을 얹는다. 새로 조회하는 것은 없다.
  const detail: RunDetail = {
    ...state,
    axes: readAxes(id),
    cards: readCards(id),
    steps: steps(state.trace, state.status),
    links: readLinks(id, state.fixture_id),
    exports: readExports(id),
  };
  return NextResponse.json(detail);
}


/** 실행을 지운다. 화면의 「삭제」가 부른다 — 사람이 두 번 눌러야 여기까지 온다. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = store.removeRun(id);
  if (r.ok) return NextResponse.json({ ok: true });
  return NextResponse.json(r, { status: r.error === 'run_not_found' ? 404 : 409 });
}
