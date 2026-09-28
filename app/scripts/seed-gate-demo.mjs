#!/usr/bin/env node
/**
 * 발행 게이트 데모 심기 — 모델을 부르지 않고 승인 화면을 연다.
 *
 * `fixtures/publish-gate/` 에 있는 실행의 카드 · 도구 기록을 `runs/demo-gate-*` 로 복사하고,
 * 떠 있는 개발 서버에 「다시 판정」(POST /api/runs/{id}/publish/gate)을 불러 게이트를 돌린다.
 * 판정은 실제 실행과 같은 코드(`gateRun`)가 한다 — 심는 것은 입력뿐이다.
 *
 * ⚠️ 실제 실행 기록이 아니다. run_id 에 `demo-gate-` 를 붙여 구별하고, 평가나 증거로 쓰지 않는다.
 * ⚠️ 기준을 통과한 건은 곧바로 발송된다. 그래서 서버가 DRY_RUN 이 아니면 아무것도 심지 않는다.
 * 다시 판정(retry)은 이어 돌릴 에이전트 세션이 없어 꺼져 보인다.
 *
 *   npm run dev                      # 다른 창에서
 *   npm run demo:gate                # 또는 node scripts/seed-gate-demo.mjs [http://localhost:3010]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS = join(ROOT, 'runs');
const BASE = (process.argv[2] ?? process.env.DEMO_BASE ?? 'http://localhost:3010').replace(/\/$/, '');

/** 무엇을 보여 주려는지가 곧 고른 이유다. */
const DEMOS = [
  { id: 'demo-gate-error-creep', from: 'fixtures/publish-gate/validation/f6-error-creep', show: '앱 에러 2→9 — errors_up 으로 멈춤' },
  { id: 'demo-gate-deploy-fail', from: 'fixtures/publish-gate/holdout/f2-deploy-fail', show: '배포 실패 · 에러 1→6 — 기준 두 개에 걸림' },
  { id: 'demo-gate-tool-failed', from: 'fixtures/publish-gate/validation/f5-metrics-down', show: '사용자 지표 조회 실패 — tool_failed. 카드 수정·삭제를 해 보기 좋다' },
  // 실제 실행이 아니라 데모용으로 만든 입력이다 (f1 에서 12일 방치 이슈만 뺐다). demo-inputs/quiet-week/README.md
  { id: 'demo-gate-quiet-week', from: 'app/scripts/demo-inputs/quiet-week', show: '조용한 주(데모용으로 만든 입력) — 기준 통과, 자동 발행(DRY_RUN)' },
];

async function api(path, init) {
  const res = await fetch(BASE + path, init).catch(() => null);
  if (!res) throw new Error(`${BASE} 에 닿지 못했다. 먼저 npm run dev 로 서버를 띄운다`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** 도구 기록에서 기간을 읽는다. 화면의 SUMMARY 가 이 값을 쓴다. */
function periodOf(toolcallsPath) {
  for (const line of readFileSync(toolcallsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const p = JSON.parse(line).output?.period;
    // 픽스처는 시각까지 적는다(2026-09-02T00:00:00+09:00). 실제 실행처럼 날짜만 남긴다.
    if (p?.since && p?.until) return { since: String(p.since).slice(0, 10), until: String(p.until).slice(0, 10) };
  }
  return null;
}

const queue = await api('/api/publish');
if (queue.status !== 200) throw new Error(`/api/publish 가 ${queue.status} 를 돌려줬다`);
if (!queue.body.dry_run) {
  console.error('서버가 PUBLISH_DRY_RUN=0 이다 — 기준을 통과한 데모가 실제 슬랙으로 나간다. .env.local 을 PUBLISH_DRY_RUN=1 로 두고 다시 부른다.');
  process.exit(1);
}

const now = new Date().toISOString();
for (const d of DEMOS) {
  const src = join(ROOT, d.from);
  const dir = join(RUNS, d.id);
  if (!existsSync(join(src, 'cards'))) throw new Error(`${src} 에 cards 가 없다`);
  rmSync(dir, { recursive: true, force: true }); // 몇 번을 불러도 처음 상태에서 다시 시작한다
  mkdirSync(dir, { recursive: true });
  cpSync(join(src, 'cards'), join(dir, 'cards'), { recursive: true });
  cpSync(join(src, 'toolcalls.jsonl'), join(dir, 'toolcalls.jsonl'));
  writeFileSync(join(dir, 'ui-state.json'), JSON.stringify({
    run_id: d.id, fixture_id: null, engine: 'claude', status: 'done',
    created_at: now, updated_at: now,
    goal: `[데모 · 실제 실행 아님] ${d.from} 의 카드 · 도구 기록으로 발행 게이트를 연다 — ${d.show}`,
    trace: [], pending_question: null, pending_approval: null, answered: [], decisions: [],
    usage: null, charts: [], period: periodOf(join(src, 'toolcalls.jsonl')), live: false,
  }, null, 2));

  const r = await api(`/api/runs/${d.id}/publish/gate`, { method: 'POST' });
  const p = r.body.publish;
  if (r.status !== 200 || !p) throw new Error(`${d.id} 판정 실패: ${r.status} ${JSON.stringify(r.body)}`);
  const why = p.gate.hits.map((h) => h.rule).join(', ') || '기준 통과';
  console.log(`${d.id.padEnd(24)} ${p.status.padEnd(15)} ${why}`);
}

console.log(`\n대기 목록: ${BASE}/publish`);
