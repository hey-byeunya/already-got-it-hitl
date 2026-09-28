/**
 * 디스크에 이미 있는 것을 화면 모양으로 바꾼다. **새로 수집하지 않는다.**
 *
 *  - runs/{id}/toolcalls.jsonl — MCP 서버가 남긴 도구 입출력 전문 → [ AXES ] 4축 타일
 *  - runs/{id}/cards/NN.json   — compose_card 가 남긴 카드 → [ CARDS ] 목록
 *  - RunState.trace            — → [ PROGRESS ] 6단계
 *
 * 실행에 따라 이 파일들이 **없을 수 있다** (도구를 부르기 전에 실패한 실행 등).
 * 그때는 조용히 빈 값을 돌려준다 — 화면이 깨지는 것보다 «아직 없다»가 낫다.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR } from './paths';
import type { AxesView, AxisTile, CardView, ExportView, RunLinks, Step, TraceEvent } from './types';

const EMPTY_AXES: AxesView = {
  tiles: [
    { key: 'system', value: null, note: 'deploy', tone: 'mut' },
    { key: 'users', value: null, note: 'active', tone: 'mut' },
    { key: 'dev', value: null, note: 'commits', tone: 'mut' },
    { key: 'trend', value: null, note: 'hit', tone: 'mut' },
  ],
  unavailable_fields: [],
  collected: false,
};

type ToolCall = { seq: number; tool: string; input?: unknown; output: unknown; ok: boolean };

function readToolCalls(runId: string): ToolCall[] {
  const path = join(RUNS_DIR, runId, 'toolcalls.jsonl');
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => {
        // 한 줄이 깨져도 나머지는 읽는다. 기록 하나 때문에 화면이 비면 안 된다.
        try { return [JSON.parse(l) as ToolCall]; } catch { return []; }
      });
  } catch { return []; }
}

const obj = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' ? v as Record<string, unknown> : {});

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 그 도구가 성공적으로 돌려준 마지막 결과. */
function lastOutput(calls: ToolCall[], tool: string): Record<string, unknown> | null {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i]!.tool === tool && calls[i]!.ok) return obj(calls[i]!.output);
  }
  return null;
}

/** 증감 꼬리표. 비교값이 없으면 붙이지 않는다 — 없는 비교를 지어내지 않는다. */
function delta(now: number | null, prev: number | null): { text: string; tone: AxisTile['tone'] } {
  if (now === null || prev === null) return { text: '', tone: 'mut' };
  const d = now - prev;
  if (d === 0) return { text: ' · ±0', tone: 'mut' };
  return { text: ` · ${d > 0 ? '+' : '−'}${Math.abs(d)}`, tone: d > 0 ? 'ok' : 'warn' };
}

export function readAxes(runId: string): AxesView {
  const calls = readToolCalls(runId);
  if (!calls.length) return EMPTY_AXES;

  const sys = lastOutput(calls, 'get_system_health');
  const met = lastOutput(calls, 'get_user_metrics');
  const dev = lastOutput(calls, 'get_dev_activity');
  const web = lastOutput(calls, 'web_search');

  const sysSum = obj(sys?.summary);
  const sysErr = num(sysSum.error);
  const totals = obj(met?.totals);
  const prev = obj(met?.previous_period_totals);
  const devSum = obj(dev?.summary);
  const commits = num(obj(dev?.commits).count);
  const issues = num(devSum.open_issue_count);
  const hits = Array.isArray(web?.results) ? (web!.results as unknown[]).length : null;

  const active = num(totals.active_users);
  const activeDelta = delta(active, num(prev.active_users));
  // 앱 에러 로그 수 (already-got-it 의 error_logs 행 수).
  // system 타일의 err(실패한 Vercel 배포 수)와 다른 값이라 이름을 구분한다.
  // null 이면(테이블 없음 등) 붙이지 않는다 — 0 으로 채우지 않는다.
  const appErr = num(totals.errors_total);

  // 에러 구간은 note 와 분리한다. 0 초과일 때만 bad 색으로 그리고,
  // 0이면 이전처럼 흐리게 둔다. null(결측)이면 붙이지 않는다.
  const alertOf = (label: string, n: number | null): AxisTile['alert'] | {} =>
    n === null ? {} : { alert: { text: `${label} ${n}`, tone: n > 0 ? 'bad' : 'mut' as const } };

  const tiles: AxisTile[] = [
    {
      key: 'system',
      value: num(sysSum.total),
      // 배포 중(빌드) 에러 수다. 앱 에러 로그(apperr)와 다른 값이라 이름을 구분한다.
      note: 'deploy',
      ...alertOf('builderr', sysErr),
      tone: sys ? 'ok' : 'mut',
    },
    {
      key: 'users',
      value: active,
      note: `active${activeDelta.text}`,
      ...alertOf('apperr', appErr),
      tone: activeDelta.tone,
    },
    {
      key: 'dev',
      value: commits,
      note: `commits${issues !== null ? ` · iss ${issues}` : ''}`,
      tone: 'mut',
    },
    { key: 'trend', value: hits, note: 'hit · 의존성', tone: 'mut' },
  ];

  // 결측은 각 도구가 스스로 알린다. 화면은 그것을 모아 보여줄 뿐이다.
  const unavailable = new Set<string>();
  for (const src of [sys, met, dev, web]) {
    const fields = src?.unavailable_fields;
    if (Array.isArray(fields)) for (const f of fields) unavailable.add(String(f));
  }

  return { tiles, unavailable_fields: [...unavailable], collected: true };
}

/** compose_card 가 남긴 카드. 분류 칸(category)으로, 그 칸이 없는 옛 카드는 accent·chart_path 로 심각도를 정한다. */
export function readCards(runId: string): CardView[] {
  const dir = join(RUNS_DIR, runId, 'cards');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .sort()
      .flatMap((f) => {
        try {
          const c = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
          const kind = (c.kind === 'cover' || c.kind === 'metric' ? c.kind : 'text') as CardView['kind'];
          const chart = typeof c.chart_path === 'string' ? c.chart_path : undefined;
          // 분류 칸(category, D40)이 정본이다. 그 칸이 생기기 전 카드는 색(accent)으로 본다.
          const cat = c.category === 'fix_now' || c.category === 'watch' || c.category === 'fyi' ? c.category : null;
          const severity: CardView['severity'] =
            kind === 'cover' ? 'COVER'
              : (cat ? cat === 'fix_now' : c.accent === 'bad') ? 'FIX_NOW'
                : (cat ? cat === 'watch' : c.accent === 'warn') ? 'WATCH'
                  : chart ? 'METRICS' : 'FYI';
          return [{
            card_no: Number(f.replace('.json', '')),
            kind,
            title: String(c.title ?? ''),
            body: Array.isArray(c.body) ? c.body.map(String) : [],
            sources: Array.isArray(c.sources) ? c.sources.map(String) : [],
            ...(chart ? { chart_path: chart } : {}),
            severity,
          } satisfies CardView];
        } catch { return []; }
      })
      .sort((a, b) => a.card_no - b.card_no);
  } catch { return []; }
}

/**
 * [ PROGRESS ] 6단계. 트레이스의 kind 에서 유도한다.
 *
 * 단계 모델을 따로 저장하지 않는 이유: 저장하면 트레이스와 어긋날 수 있다.
 * 트레이스가 사실이고 이건 그 사실을 읽는 방식이다.
 */
export function steps(trace: TraceEvent[], status?: string): Step[] {
  const has = (pred: (e: TraceEvent) => boolean) => trace.some(pred);
  const toolNamed = (name: string) => (e: TraceEvent) =>
    e.kind === 'tool_use' && e.label.includes(name);

  const collected = has((e) => e.kind === 'tool_use'
    && ['get_system_health', 'get_user_metrics', 'get_dev_activity', 'web_search']
      .some((t) => e.label.includes(t)));
  const asked = has((e) => e.kind === 'question_waiting');
  const answered = has((e) => e.kind === 'question_answered' || e.kind === 'question_declined');
  const charted = has(toolNamed('render_chart'));
  const composed = has(toolNamed('compose_card'));
  const proposed = has((e) => e.kind === 'approval_waiting');
  const decided = has((e) => e.kind === 'approval_granted' || e.kind === 'approval_denied');
  // 실패·중단은 «끝냈다»가 아니다. finished 이벤트만 완료로 본다 —
  // 그러지 않으면 실패한 실행이 «finalize draft ✓» 로 보인다 (화면을 열어 보고 발견했다).
  const finished = has((e) => e.kind === 'finished');
  // 끝난 실행에는 «지금» 이 없다. 멈춘 자리를 진행 중으로 그리면 아직 도는 것처럼 읽힌다.
  const over = status !== undefined
    && ['done', 'failed', 'stopped', 'interrupted'].includes(status);

  // 대기 중인 게이트가 있으면 그 자리가 «지금»이다. 없으면 **끝나지 않은 첫 단계** 하나만.
  // 처음에는 «끝나지 않았고 앞이 끝났으면 지금» 으로 뒀는데, 그러면 ◆ 가 여러 개 켜져
  // 어디서 멈춰 있는지 알 수 없었다 (화면을 열어 보고 발견했다).
  const raw: { label: string; done: boolean; waiting?: boolean }[] = [
    { label: 'collect 4-axis', done: collected },
    {
      label: asked && !answered ? 'ask_user - 답을 기다린다' : 'pick axis',
      done: answered,
      waiting: asked && !answered,
    },
    { label: 'storyboard', done: composed },
    { label: 'render_chart', done: charted },
    {
      label: proposed && !decided ? 'propose issue - 승인 대기' : 'propose issue',
      done: decided,
      waiting: proposed && !decided,
    },
    { label: 'finalize draft', done: finished },
  ];

  const waitingAt = raw.findIndex((r) => r.waiting);
  // 중단된 실행은 «어디서 멈췄는지» 를 보여줘야 하므로 대기 자리는 남긴다.
  const currentAt = waitingAt >= 0 ? waitingAt : over ? -1 : raw.findIndex((r) => !r.done);

  return raw.map((r, i) => ({
    label: r.label,
    state: r.done ? 'done' : i === currentAt ? 'current' : 'pending',
  }));
}

/** 홈 목록의 결과 한 줄. 있는 것 중 가장 중요한 하나만 고른다. */
export function resultLine(s: {
  status: string;
  charts: { card_no: number }[];
  stop_reason?: { limit: string; message: string } | undefined;
  decisions: { approved: boolean; tool: string }[];
  trace: TraceEvent[];
  final_text?: string | undefined;
}, cardCount: number): string {
  if (s.status === 'failed') {
    const err = [...s.trace].reverse().find((e) => e.isError);
    return err?.detail?.split('\n')[0]?.slice(0, 80) ?? '실행 실패';
  }
  if (s.stop_reason) return `${s.stop_reason.limit} - 부분 결과 보존`;
  if (s.status === 'interrupted') return '중단 - 대기 콜백 소실';

  const parts: string[] = [];
  const cards = cardCount || s.charts.length;
  if (cards) parts.push(`카드 ${cards}장`);
  const approved = s.decisions.filter((d) => d.approved).length;
  const rejected = s.decisions.filter((d) => !d.approved).length;
  if (approved) parts.push(`이슈 ${approved}건 생성`);
  if (rejected) parts.push(`제안 ${rejected}건 거절`);
  if (s.status === 'waiting_for_user') parts.push('사람의 답 대기');
  if (!parts.length) return s.final_text ? '원고 작성됨' : '아직 결과 없음';
  return parts.join(' · ');
}


// ───────────────────────────────────────────────── 바깥으로 나가는 주소

/** owner/name 만 받는다. 여기서 막지 않으면 도구 출력이 그대로 URL 이 된다. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** http(s) 가 아닌 것은 링크로 만들지 않는다 (javascript: 같은 것). */
function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}

/**
 * 이 실행이 언급한 이슈·PR·검색 결과의 주소를 모은다.
 *
 * 이슈·PR 주소는 도구가 주지 않아 repo 와 번호로 **조립한다.**
 * 그래서 픽스처 실행에서는 실제로 없는 이슈를 가리킬 수 있다 —
 * `snapshot: true` 로 그 사실을 함께 내려보내고, 화면이 밝힌다.
 */
export function readLinks(runId: string, fixtureId: string | null): RunLinks {
  const snapshot = fixtureId !== null;
  const empty: RunLinks = {
    repo: null, issues: [], pulls: [], web: [], created: [], snapshot,
  };

  const calls = readToolCalls(runId);
  const dev = calls.filter((c) => c.tool === 'get_dev_activity' && c.ok).pop();
  const rawRepo = (dev?.input as { repo?: unknown } | undefined)?.repo;
  const repo = typeof rawRepo === 'string' && REPO_RE.test(rawRepo) ? rawRepo : null;

  const out: RunLinks = { ...empty, repo };

  if (repo && dev) {
    const o = obj(dev.output);
    const issues = Array.isArray(o.open_issues) ? o.open_issues : [];
    for (const raw of issues) {
      const i = obj(raw);
      const n = num(i.number);
      if (n === null) continue;
      out.issues.push({
        number: n,
        title: typeof i.title === 'string' ? i.title : '',
        url: `https://github.com/${repo}/issues/${n}`,
      });
    }
    const pulls = Array.isArray(o.pull_requests) ? o.pull_requests : [];
    for (const raw of pulls) {
      const n = num(obj(raw).number);
      if (n !== null) out.pulls.push({ number: n, url: `https://github.com/${repo}/pull/${n}` });
    }
  }

  // 검색 출처. 같은 url 이 여러 질의에서 나오므로 접는다.
  const seen = new Set<string>();
  for (const c of calls) {
    if (c.tool !== 'web_search' || !c.ok) continue;
    const results = obj(c.output).results;
    if (!Array.isArray(results)) continue;
    for (const raw of results) {
      const r = obj(raw);
      const url = safeUrl(r.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.web.push({
        title: typeof r.title === 'string' ? r.title : url,
        url,
        published_at: typeof r.published_at === 'string' ? r.published_at : null,
      });
    }
  }

  // 승인을 받아 만든 이슈. 기록은 MCP 서버의 approvals.json 이 정본이다.
  try {
    const p = join(RUNS_DIR, runId, 'approvals.json');
    if (existsSync(p)) {
      const store = JSON.parse(readFileSync(p, 'utf8')) as { log?: unknown };
      for (const raw of Array.isArray(store.log) ? store.log : []) {
        const created = obj(obj(raw).created);
        const n = num(created.issue_number);
        const r = typeof created.repo === 'string' ? created.repo : repo;
        if (n === null || !r) continue;
        out.created.push({
          number: n,
          repo: r,
          // 픽스처에서 만든 이슈는 실제로 없다. 주소를 주면 없는 곳을 가리킨다.
          url: snapshot || !REPO_RE.test(r) ? null : `https://github.com/${r}/issues/${n}`,
          simulated: snapshot,
        });
      }
    }
  } catch { /* 기록이 깨졌으면 링크 없이 간다 */ }

  return out;
}


/** 내보낸 파일이 실제로 있는지 본다. 있다고 적힌 것과 있는 것은 다르다 (opened_ok 원칙). */
export function readExports(runId: string): ExportView {
  const dir = join(RUNS_DIR, runId);
  const zipName = `cardnews-${runId}.zip`;
  const zipPath = join(dir, zipName);

  let zip: ExportView['zip'] = null;
  try {
    if (existsSync(zipPath)) zip = { name: zipName, bytes: statSync(zipPath).size };
  } catch { /* 읽을 수 없으면 없는 것으로 본다 */ }

  const png: ExportView['png'] = [];
  try {
    const pngDir = join(dir, 'png');
    if (existsSync(pngDir)) {
      for (const f of readdirSync(pngDir).filter((x) => /^\d+\.png$/.test(x)).sort()) {
        png.push({ card_no: Number(f.replace('.png', '')), bytes: statSync(join(pngDir, f)).size });
      }
    }
  } catch { /* 같음 */ }

  return { zip, sources: existsSync(join(dir, 'SOURCES.md')), png };
}
