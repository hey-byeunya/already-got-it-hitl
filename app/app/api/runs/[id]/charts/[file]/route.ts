import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR } from '@/lib/paths';
import { isValidRunId } from '@/lib/store';

export const runtime = 'nodejs';

/** 생성된 SVG 를 그대로 내려준다. 경로는 runs/{id}/charts/ 안으로 제한한다. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await ctx.params;
  if (!isValidRunId(id) || !/^[0-9]{1,3}\.svg$/.test(file)) {
    return new Response('bad request', { status: 400 });
  }
  const p = join(RUNS_DIR, id, 'charts', file);
  if (!existsSync(p)) return new Response('not found', { status: 404 });
  return new Response(readFileSync(p, 'utf8'), {
    headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' },
  });
}
