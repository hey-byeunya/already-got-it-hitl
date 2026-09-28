import { NextResponse } from 'next/server';
import * as store from '@/lib/store';
import { sendSlack } from '@/lib/publish';

export const runtime = 'nodejs';

/**
 * 보내지 못한 건(send_failed)을 다시 보낸다. 승인은 이미 받은 건이다.
 * 이미 나간 건(published)은 beginSend 가 거절한다 — 웹훅 메시지는 지울 수 없으니 두 번 보내지 않는다.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!store.readState(id)) return NextResponse.json({ error: 'run_not_found' }, { status: 404 });
  store.appendTrace(id, { kind: 'publish', label: '슬랙 발행 - 다시 보내기' });
  const r = await sendSlack(id);
  if (!r.ok) return NextResponse.json({ error: r.error, message: r.message }, { status: r.error === 'no_publish' ? 404 : 409 });
  return NextResponse.json({ ok: true, publish: r.state });
}
