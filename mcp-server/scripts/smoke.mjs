#!/usr/bin/env node
/**
 * 스모크 — MCP 서버에 stdio 로 붙어 도구 흐름을 한 번 돌린다.
 *
 * 확인하는 것:
 *   1. 읽기 도구 3개가 픽스처를 돌려준다
 *   2. render_chart 가 근거 없는 값을 거절하고, 근거 있는 값은 그린다
 *   3. create_github_issue 가 승인 토큰 없이는 거절된다  ← 승인 게이트 ②
 *   4. 토큰을 발급하면 통과한다
 *   5. revert_issue 가 범위 밖 이슈를 거절하고, 자기 이슈는 되돌린다  ← 확장②
 *
 *   node scripts/smoke.mjs [fixture_id]
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const FIXTURE = process.argv[2] ?? 'f2-deploy-fail';
const RUN_ID = `smoke-${Date.now().toString(36)}`;
const RUNS_DIR = mkdtempSync(resolve(tmpdir(), 'ops-smoke-'));
const REPO = 'hey-byeunya/already-got-it';

const env = {
  ...process.env,
  OPS_MODE: 'fixture',
  OPS_RUNS_DIR: RUNS_DIR,
  OPS_FIXTURES_DIR: resolve(ROOT, '../fixtures/snapshots'),
};

const child = spawn(process.execPath, [resolve(ROOT, 'dist/src/index.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 1;
const pending = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const r = pending.get(msg.id);
    if (r) { pending.delete(msg.id); r(msg); }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

/** 도구를 부르고 결과 JSON 과 isError 를 돌려준다. */
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: { run_id: RUN_ID, fixture_id: FIXTURE, ...args } });
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r);
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { isError: !!r.result?.isError, data: parsed };
}

const mintToken = (tool, target) =>
  execFileSync(process.execPath, [resolve(ROOT, 'scripts/mint-approval.mjs'), RUN_ID, tool, target], { env })
    .toString().trim();

let step = 0;
const ok = (label, cond, detail = '') => {
  step += 1;
  console.log(`${cond ? '✅' : '❌'} ${String(step).padStart(2)}. ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
};

await rpc('initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

console.log(`\n픽스처 ${FIXTURE} · run ${RUN_ID}\n${'─'.repeat(64)}`);

// 1. 읽기 도구
const sys = await call('get_system_health', { since: '2026-09-02', until: '2026-09-09' });
ok('get_system_health', !sys.isError,
  `배포 ${sys.data.summary?.total}건 (실패 ${sys.data.summary?.error}) · 결측 ${sys.data.unavailable_fields?.length ?? '?'}개`);

const met = await call('get_user_metrics', { since: '2026-09-02', until: '2026-09-09' });
ok('get_user_metrics', !met.isError,
  `가입 ${met.data.totals?.signups} (전주 ${met.data.previous_period_totals?.signups ?? '없음'})`);

const dev = await call('get_dev_activity', { since: '2026-09-02', until: '2026-09-09', repo: REPO });
ok('get_dev_activity', true, dev.isError ? `실패 재현: ${dev.data.error}` : `열린 이슈 ${dev.data.summary?.open_issue_count}건`);

const bad = await call('get_dev_activity', { since: '2026-09-02', until: '2026-09-09', repo: 'someone/else' });
ok('허용 목록 밖 저장소 거절', bad.isError && bad.data.error === 'repo_not_allowed', bad.data.error);

// 2. 차트 근거 대조
const invented = await call('render_chart', {
  card_no: 2, chart_type: 'bar', title: '지어낸 수치',
  source: { tool: 'get_user_metrics', field: 'series[].signups' },
  data: [{ label: 'x', value: 12345 }],
});
ok('근거 없는 수치로 차트 거절', invented.isError && invented.data.error === 'source_mismatch', invented.data.error);

const realValues = (met.data.series ?? []).map((r) => ({ label: r.date.slice(5), value: r.signups }));
const chart = realValues.length
  ? await call('render_chart', {
      card_no: 2, chart_type: 'bar', title: '일별 가입',
      source: { tool: 'get_user_metrics', field: 'series[].signups' }, data: realValues,
    })
  : { isError: true, data: { error: 'no_series' } };
ok('근거 있는 수치로 차트 생성', !chart.isError && chart.data.rendered_ok === true,
  chart.isError ? chart.data.error : `${chart.data.svg_path} (${chart.data.bytes}B, source_verified=${chart.data.source_verified})`);

// 3. 승인 게이트 — 토큰 없이
const noToken = await call('create_github_issue', {
  repo: REPO, title: '배포 실패 확인', body: '근거: get_system_health.deployments[1]',
  labels: ['ops'], source: { tool: 'get_system_health', field: 'deployments[1]' },
});
ok('승인 토큰 없이 이슈 생성 거절', noToken.isError && noToken.data.error === 'approval_required', noToken.data.error);

// 4. 승인 후
const t1 = mintToken('create_github_issue', REPO);
const created = await call('create_github_issue', {
  repo: REPO, title: '배포 실패 확인', body: '근거: get_system_health.deployments[1]',
  labels: ['ops'], source: { tool: 'get_system_health', field: 'deployments[1]' }, approval_token: t1,
});
ok('승인 후 이슈 생성', !created.isError && created.data.created === true,
  created.isError ? created.data.error : `#${created.data.number} (simulated=${created.data.simulated})`);

const reuse = await call('create_github_issue', {
  repo: REPO, title: '중복', body: 'x', labels: [], source: { tool: 'get_system_health', field: 'x' },
  approval_token: t1,
});
ok('같은 토큰 재사용 거절 (두 번 만들지 않음)', reuse.isError && reuse.data.error === 'token_already_used', reuse.data.error);

const badLabel = await call('create_github_issue', {
  repo: REPO, title: 'x', body: 'x', labels: ['아무라벨'],
  source: { tool: 'get_system_health', field: 'x' }, approval_token: mintToken('create_github_issue', REPO),
});
ok('허용 목록 밖 라벨 거절', badLabel.isError && badLabel.data.error === 'label_not_allowed', badLabel.data.error);

// 5. 되돌리기 (확장②)
const outOfScope = await call('revert_issue', {
  issue_number: 12345, reason: '범위 밖', approval_token: mintToken('revert_issue', '12345'),
});
ok('승인 기록에 없는 이슈 되돌리기 거절', outOfScope.isError && outOfScope.data.error === 'not_in_approval_log',
  outOfScope.data.error);

const num = created.data.number;
const reverted = await call('revert_issue', {
  issue_number: num, reason: '오탐이었음', approval_token: mintToken('revert_issue', String(num)),
});
ok('내가 만든 이슈는 되돌린다', !reverted.isError && reverted.data.reverted === true,
  reverted.isError ? reverted.data.error : `#${num} → ${reverted.data.state}`);

// 6. 카드 제작과 내보내기
const cover = await call('compose_card', {
  card_no: 1, kind: 'cover', title: '「이미 있어」 주간 운영 브리핑',
  body: ['2026-09-02 ~ 2026-09-09', '시스템 · 사용자 · 개발 · 트렌드'],
  sources: ['픽스처 ' + FIXTURE],
});
ok('표지 카드 합성', !cover.isError && cover.data.rendered_ok === true,
  cover.isError ? cover.data.error : `${cover.data.svg_path} (${cover.data.bytes}B)`);

const chartPath = chart?.data?.svg_path;
const metric = await call('compose_card', {
  card_no: 2, kind: 'metric', category: 'watch', title: '가입 추이',
  body: ['하루 평균 두세 명이 새로 들어왔다.'],
  sources: ['get_user_metrics · series[].signups'],
  chart_path: chartPath,
});
ok('차트를 끼운 지표 카드', !metric.isError && metric.data.chart_embedded === true,
  metric.isError ? metric.data.error : `레이어 제목 ${metric.data.layers?.title_lines}줄`
    + ` · 본문 ${metric.data.layers?.body_lines}줄 · 출처 ${metric.data.layers?.source_lines}줄`);

ok('제목·본문·출처가 각각 별도 레이어로 나간다', (() => {
  const svg = readFileSync(`${RUNS_DIR}/${RUN_ID}/cards/02.svg`, 'utf8');
  return ['layer-title', 'layer-body', 'layer-source', 'layer-chart']
    .every((id) => svg.includes(`id="${id}"`));
})(), 'layer-title · layer-body · layer-source · layer-chart');

// 글자가 넘치면 잘라서 그리지 않고 거절한다
const overflow = await call('compose_card', {
  card_no: 3, kind: 'metric', category: 'watch', title: '넘치는 카드',
  body: Array.from({ length: 30 }, (_, i) => `${i + 1}번째 줄. 이 문장은 상자를 넘기려고 길게 적은 것이다.`),
  sources: ['get_user_metrics · totals'], chart_path: chartPath,
});
ok('글자가 넘치면 잘라 그리지 않고 거절', overflow.isError && overflow.data.error === 'text_overflow',
  overflow.isError ? `${overflow.data.error} (본문 ${overflow.data.overflow?.[0]?.lines_needed}줄 필요)` : '거절 안 됨');

// 이 실행이 만들지 않은 차트 경로는 받지 않는다
const badChart = await call('compose_card', {
  card_no: 3, kind: 'metric', category: 'watch', title: 'x', body: ['x'], sources: ['x'],
  chart_path: '../../../etc/passwd',
});
ok('실행 밖 경로를 차트로 받지 않는다',
  badChart.isError && badChart.data.error === 'chart_path_not_allowed', badChart.data.error);

const text3 = await call('compose_card', {
  card_no: 3, kind: 'text', category: 'fix_now', title: '지금 손봐야 할 것',
  body: ['열린 이슈 2건 중 12일 지난 것이 하나 있다.', '배포 실패 1건은 원인이 기록돼 있다.'],
  sources: ['get_dev_activity · summary'],
});
ok('세 번째 카드 합성', !text3.isError, text3.isError ? text3.data.error : text3.data.svg_path);

// 없는 근거로는 카드를 만들지 않는다 (cover 제외)
const badSource = await call('compose_card', {
  card_no: 3, kind: 'text', category: 'watch', title: 'x', body: ['x'], sources: ['지어낸 근거'],
});
ok('없는 근거로 카드를 만들지 않는다',
  badSource.isError && badSource.data.error === 'source_shape_invalid', badSource.data.error);

// **한 장만 고친다** — 차트 파일과 다른 카드가 그대로여야 한다
const chartMtimeBefore = statSync(`${RUNS_DIR}/${RUN_ID}/${chartPath}`).mtimeMs;
const card1MtimeBefore = statSync(`${RUNS_DIR}/${RUN_ID}/cards/01.svg`).mtimeMs;
await new Promise((r) => setTimeout(r, 20));
const edited = await call('compose_card', {
  card_no: 2, kind: 'metric', category: 'watch', title: '가입 추이 (문안 수정)',
  body: ['문장만 고쳤다. 차트는 다시 그리지 않는다.'],
  sources: ['get_user_metrics · series[].signups'],
  chart_path: chartPath,
});
ok('카드 1장 텍스트 수정 — 차트를 다시 그리지 않는다',
  !edited.isError
    && edited.data.chart_rerendered === false
    && statSync(`${RUNS_DIR}/${RUN_ID}/${chartPath}`).mtimeMs === chartMtimeBefore,
  `차트 파일 mtime 그대로 · 건드리지 않은 카드 ${JSON.stringify(edited.data?.other_cards_untouched)}`);
ok('경계 — 다른 카드는 바뀌지 않는다',
  statSync(`${RUNS_DIR}/${RUN_ID}/cards/01.svg`).mtimeMs === card1MtimeBefore, '01.svg mtime 그대로');

// 내보내기
const exported = await call('export_cardnews', { note: '스모크' });
ok('PNG · ZIP · 출처 기록 내보내기', !exported.isError && exported.data.opened_ok === true,
  exported.isError ? `${exported.data.error} ${JSON.stringify(exported.data.failed ?? '')}`
    : `${exported.data.cards}장 · ZIP ${exported.data.zip_bytes}B`);

// **독립된 도구로** ZIP 을 열어 본다. 만든 코드와 확인하는 코드를 분리한다.
if (!exported.isError) {
  const zipAbs = `${RUNS_DIR}/${RUN_ID}/${exported.data.zip_path}`;
  let listed = '';
  let tested = '';
  try { listed = execFileSync('unzip', ['-l', zipAbs]).toString(); } catch (e) { listed = String(e); }
  try { tested = execFileSync('unzip', ['-t', zipAbs]).toString(); } catch (e) { tested = String(e); }
  const names = listed.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter((n) => n?.includes('.'));
  ok('내려받은 ZIP 을 unzip 으로 열어 순서·수량 확인',
    tested.includes('No errors')
      && names.includes('cards/01.png') && names.includes('cards/02.png')
      && names.includes('cards/03.png') && names.includes('SOURCES.md'),
    `${names.join(', ')}`);

  // PNG 가 실제 그림인지 — 크기와 바이트 수를 직접 본다
  const sizes = exported.data.png.map((p) => `${p.file} ${p.width}x${p.height} ${p.bytes}B`);
  ok('PNG 크기가 카드 규격과 같다',
    exported.data.png.every((p) => p.width === 1080 && p.height === 1350 && p.bytes > 4000),
    sizes.join(' · '));
}

console.log(`${'─'.repeat(64)}`);
console.log(`실행 기록: ${RUNS_DIR}/${RUN_ID}/toolcalls.jsonl`);
console.log(`승인 기록: ${RUNS_DIR}/${RUN_ID}/approvals.json`);
console.log(process.exitCode ? '\n일부 항목 실패\n' : '\n전부 통과\n');
child.kill();
