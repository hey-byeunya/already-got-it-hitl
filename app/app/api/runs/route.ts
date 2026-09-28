import { NextResponse } from 'next/server';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_DIR } from '@/lib/paths';
import * as store from '@/lib/store';
import { credentialSource, liveWritesEnabled, opsMode, start } from '@/lib/runner';
import { limitsFromEnv } from 'already-got-it-ops-agent/limits';

export const runtime = 'nodejs';

/**
 * 픽스처의 사람이 읽을 라벨까지 함께 준다.
 * 라벨은 fixtures/snapshots/*.json 에 원래 있었는데 화면까지 오지 않아서,
 * 화면이 같은 설명을 따로 하드코딩하고 있었다 — 두 곳이 어긋날 수 있는 구조였다.
 */
function listFixtures(): { id: string; label: string }[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const id = f.replace('.json', '');
      try {
        const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')) as { label?: unknown };
        return { id, label: typeof fx.label === 'string' ? fx.label : id };
      } catch {
        return { id, label: id };
      }
    });
}

export function GET() {
  return NextResponse.json({
    runs: store.listRuns(),
    fixtures: listFixtures(),
    credential_source: credentialSource(),
    limits: limitsFromEnv(),
    mode: opsMode(),
    live_writes: liveWritesEnabled(),
    allowed_repos: (process.env.GITHUB_ALLOWED_REPOS ?? 'hey-byeunya/already-got-it')
      .split(',').map((x) => x.trim()).filter(Boolean),
  });
}

const DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 브리핑이 다룰 기간. 모델은 오늘 날짜를 모르므로 지시에 실제 날짜를 박는다.
 *
 * 사람이 고른 값을 그대로 믿지 않는다 — 형식이 아니거나 순서가 뒤집혔으면 기본값으로 돌아간다.
 * 뒤집힌 기간을 그대로 넘기면 도구가 빈 결과를 주고, 모델은 그것을 «활동 없음» 으로 읽는다.
 */
function resolvePeriod(body: { since?: unknown; until?: unknown }):
  { period: { since: string; until: string }; note: string | null } {
  // 화면과 같은 규칙으로 자른다 — toISOString() 은 UTC 라 한국 아침에 하루가 밀린다.
  const day = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const fallback = () => {
    const until = new Date();
    const since = new Date(until.getTime() - 7 * DAY);
    return { since: day(since), until: day(until) };
  };
  const a = typeof body.since === 'string' ? body.since.trim() : '';
  const b = typeof body.until === 'string' ? body.until.trim() : '';
  if (!a && !b) return { period: fallback(), note: null };
  if (!ISO_DATE.test(a) || !ISO_DATE.test(b)) {
    return { period: fallback(), note: '기간 형식이 YYYY-MM-DD 가 아니라 최근 7일로 되돌렸다' };
  }
  if (a >= b) {
    return { period: fallback(), note: '시작이 끝보다 뒤라 최근 7일로 되돌렸다' };
  }
  return { period: { since: a, until: b }, note: null };
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as
    { fixture_id?: string; goal?: string; focus?: string;
      since?: string; until?: string };
  const mode = opsMode();
  // live 모드에서는 픽스처를 무시한다. 화면에서 막고 있지만 여기서도 막는다 —
  // 화면만 막으면 API 를 직접 부를 때 fixture_id 가 그대로 들어와,
  // 실행 기록이 «--fixture ...» 와 «fixture 모드» 로 잘못 말한다.
  // MCP 서버도 live 에서 fixture_id 를 fixture_in_live_mode 로 거절한다 (같은 규칙, 세 겹).
  const fixtureId = mode === 'live' ? null : (body.fixture_id ?? null);
  const ignoredFixture = mode === 'live' && Boolean(body.fixture_id);
  const runId = `web-${Date.now().toString(36)}`;
  const focus = body.focus?.trim() || undefined;
  const { period, note: periodNote } = resolvePeriod(body);

  const goal = body.goal?.trim() || (
    `이번 주 「이미 있어」 운영 브리핑 카드뉴스를 만들어 줘.`
    + ` 기간은 ${period.since} 부터 ${period.until} 까지다 (도구의 since·until 에 이 값을 그대로 넘긴다).`
    + ` run_id 는 "${runId}" 를 쓴다.`
    + (focus ? ` 특히 ${focus} 축을 깊게 본다.` : '')
    + ` 스토리보드를 제시한 뒤, 지표 카드는 render_chart 로 실제 SVG 까지 그려라.`
    + ` 손봐야 할 것이 있으면 create_github_issue 를 호출해 이슈 생성을 제안해라.`
    + ` 앱 에러·배포 실패는 route·건수와 찾아갈 링크를 본문에 넣어라`
    + ` (errors_by_route[].url, deployments[]의 url·commit_url. null 이면 이름만).`
  );

  store.createRun({ runId, fixtureId, goal, ...(focus ? { focus } : {}), period });
  start({ runId, fixtureId, goal });
  const notes = [
    periodNote,
    ignoredFixture ? `live 모드라 fixture_id(${body.fixture_id})를 무시했다` : null,
  ].filter(Boolean);
  return NextResponse.json(
    { run_id: runId, mode, period, ...(notes.length ? { note: notes.join(' · ') } : {}) },
    { status: 201 },
  );
}
