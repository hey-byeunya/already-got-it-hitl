import { NextResponse } from 'next/server';
import { join } from 'node:path';
import { exportCardnews } from 'already-got-it-ops-mcp/cards';
import { ToolError } from 'already-got-it-ops-mcp/errors';
import { RUNS_DIR } from '@/lib/paths';
import * as store from '@/lib/store';

export const runtime = 'nodejs';
/** PNG 를 굽는 데 카드당 1~2초 걸린다. 기본 시간 제한으로는 8장을 못 끝낸다. */
export const maxDuration = 120;

/**
 * 카드뉴스를 내보낸다 — **사람이 눌렀을 때만.**
 *
 * 에이전트가 알아서 굽지 않는 이유: PNG 굽기는 카드당 브라우저를 한 번 띄우는 일이라
 * 느리고, 문안을 고칠 때마다 다시 구우면 낭비다. 스토리보드가 마음에 들었는지는
 * 사람이 판단한다 — 그래서 이 버튼이 있다.
 *
 * 굽기 자체는 MCP 서버의 exportCardnews 를 그대로 쓴다. 도구가 부르는 것과 같은 코드다.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const state = store.readState(id);
  if (!state) return NextResponse.json({ error: 'run_not_found' }, { status: 404 });

  if (state.cards_exporting) {
    return NextResponse.json(
      { error: 'already_exporting', message: '이미 굽고 있다. 끝날 때까지 기다린다' },
      { status: 409 },
    );
  }

  store.update(id, (s) => { s.cards_exporting = true; });
  try {
    const out = exportCardnews({
      runDir: join(RUNS_DIR, id),
      runId: id,
      mode: state.fixture_id ? 'fixture' : 'live',
    });
    store.appendTrace(id, {
      kind: 'export',
      label: `카드뉴스 내보내기 - ${out.cards}장`,
      detail: `${out.zip_path} (${out.zip_bytes.toLocaleString()}B) · ${out.entries.join(', ')}`
        + (out.card_count_note ? `\n${out.card_count_note}` : ''),
    });
    return NextResponse.json({ ok: true, ...out });
  } catch (err) {
    const payload = err instanceof ToolError
      ? err.asResult()
      : { error: 'export_failed', message: err instanceof Error ? err.message : String(err) };
    // 실패도 기록에 남긴다. 조용히 사라지면 왜 파일이 없는지 알 수 없다.
    store.appendTrace(id, {
      kind: 'error',
      label: `카드뉴스 내보내기 실패 - ${String(payload.error)}`,
      detail: JSON.stringify(payload, null, 2),
      isError: true,
    });
    return NextResponse.json(payload, { status: 409 });
  } finally {
    store.update(id, (s) => { s.cards_exporting = false; });
  }
}
