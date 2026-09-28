import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { RUNS_DIR } from '@/lib/paths';
import { isValidRunId } from '@/lib/store';

export const runtime = 'nodejs';

/**
 * 내보낸 결과물을 내려준다 — ZIP · 카드 PNG · 근거 기록.
 *
 * 경로를 조립하지 않고 **정해 둔 세 형태만** 받는다.
 * `..` 를 걸러내는 식으로 막으면 인코딩 우회가 남는다 — 아예 형태로 제한한다.
 */
function resolveTarget(runId: string, file: string):
  { path: string; type: string; name: string } | null {
  if (file === 'zip') {
    const name = `cardnews-${runId}.zip`;
    return { path: join(RUNS_DIR, runId, name), type: 'application/zip', name };
  }
  if (file === 'sources') {
    return {
      path: join(RUNS_DIR, runId, 'SOURCES.md'),
      type: 'text/markdown; charset=utf-8',
      name: `SOURCES-${runId}.md`,
    };
  }
  const png = /^([0-9]{1,3})\.png$/.exec(file);
  if (png) {
    return {
      path: join(RUNS_DIR, runId, 'png', `${png[1]}.png`),
      type: 'image/png',
      name: `${runId}-card-${png[1]}.png`,
    };
  }
  return null;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await ctx.params;
  if (!isValidRunId(id)) return new Response('bad request', { status: 400 });
  // 미리보기는 같은 파일을 **화면에 그려야** 하므로 attachment 를 붙이지 않는다.
  const inline = new URL(req.url).searchParams.has('inline');

  const target = resolveTarget(id, file);
  if (!target) return new Response('bad request', { status: 400 });
  if (!existsSync(target.path)) return new Response('not found', { status: 404 });

  // ZIP 은 수백 KB 다. 통째로 메모리에 올리지 않고 흘려보낸다.
  const stream = Readable.toWeb(createReadStream(target.path)) as ReadableStream;
  return new Response(stream, {
    headers: {
      'content-type': target.type,
      'content-length': String(statSync(target.path).size),
      ...(inline ? {} : { 'content-disposition': `attachment; filename="${target.name}"` }),
      'cache-control': 'no-store',
    },
  });
}
