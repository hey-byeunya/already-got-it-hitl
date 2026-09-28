#!/usr/bin/env node
/**
 * live 스모크 — 실제 API 에 붙어 읽기 도구가 도는지 확인한다.
 *
 * 픽스처 스모크와 별도로 두는 이유: 이건 네트워크와 사람이 발급한 토큰에 의존하므로
 * `npm run verify` 에 넣으면 검사가 환경에 따라 흔들린다. 필요할 때만 부른다.
 *
 * 확인하는 것:
 *   1. Vercel — 실제 배포 목록
 *   2. Supabase — 집계 RPC (없으면 rpc_not_created 로 **무엇을 하면 되는지** 알린다)
 *   3. GitHub — 실제 이슈·커밋
 *   4. web_search — 의존성 릴리스·보안 권고
 *   5. render_chart 가 live 데이터로도 근거 대조를 한다
 *   6. **승인 토큰이 유효해도** OPS_ALLOW_LIVE_WRITES 없이는 실제 쓰기가 막힌다
 *   7. live 모드에서 fixture_id 를 넘기면 거절된다
 *
 *   node scripts/smoke-live.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const PROJECT = resolve(ROOT, '..');
const RUN_ID = `live-${Date.now().toString(36)}`;
const RUNS_DIR = mkdtempSync(resolve(tmpdir(), 'ops-live-'));

/** .env.local 을 읽는다. 이미 설정된 환경변수는 덮어쓰지 않는다. */
function loadEnvLocal() {
  const p = resolve(PROJECT, '.env.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    if (process.env[k] === undefined) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

const REPO = (process.env.GITHUB_ALLOWED_REPOS ?? 'hey-byeunya/already-got-it').split(',')[0].trim();
const until = new Date();
const since = new Date(until.getTime() - 7 * 86400_000);
const period = { since: since.toISOString(), until: until.toISOString() };

// 자격증명은 **이름만** 확인한다. 값은 읽어서 출력하지 않는다.
const NEEDED = ['VERCEL_API_TOKEN', 'VERCEL_PROJECT_ID', 'GITHUB_TOKEN',
  'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'];
const missing = NEEDED.filter((n) => !process.env[n]?.trim());
console.log(`\nlive 스모크 · run ${RUN_ID}`);
console.log(`자격증명: ${NEEDED.filter((n) => !missing.includes(n)).join(', ') || '없음'}`
  + (missing.length ? `  |  없음: ${missing.join(', ')}` : ''));
console.log(`기간: ${period.since.slice(0, 10)} ~ ${period.until.slice(0, 10)} · 저장소 ${REPO}`);
console.log('─'.repeat(70));

const env = {
  ...process.env,
  OPS_MODE: 'live',
  OPS_RUNS_DIR: RUNS_DIR,
  // live 모드는 픽스처를 쓰지 않는다. 남아 있으면 서버가 fixture_in_live_mode 로 거절한다.
  OPS_FIXTURE_ID: '',
  GITHUB_ALLOWED_REPOS: REPO,
};
delete env.OPS_ALLOW_LIVE_WRITES;   // 6번 검사를 위해 반드시 꺼진 상태로 시작한다

const child = spawn(process.execPath, [resolve(ROOT, 'dist/src/index.js')],
  { env, stdio: ['pipe', 'pipe', 'inherit'] });
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
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: { run_id: RUN_ID, ...args } });
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
const info = (label, detail) => {
  step += 1;
  console.log(`ℹ️  ${String(step).padStart(2)}. ${label} — ${detail}`);
};

await rpc('initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-live', version: '0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// ── 1. Vercel
const sys = await call('get_system_health', period);
if (sys.isError) {
  ok('Vercel 시스템 상태', false, `${sys.data.error}: ${sys.data.message}`);
} else {
  const s = sys.data.summary;
  ok('Vercel 시스템 상태', typeof s?.total === 'number',
    `배포 ${s.total}건 (성공 ${s.ready} · 실패 ${s.error})`);
  // 결측을 0 으로 뭉개지 않는지가 이 모드의 핵심이다.
  ok('함수 오류는 0 이 아니라 결측으로 온다',
    sys.data.function_errors?.available === false
      && sys.data.function_errors?.count === null
      && sys.data.unavailable_fields?.includes('function_errors'),
    `available=${sys.data.function_errors?.available} count=${sys.data.function_errors?.count}`);
}

// ── 2. Supabase
const met = await call('get_user_metrics', { ...period, granularity: 'day' });
if (met.isError) {
  const known = ['rpc_not_created', 'metrics_token_rejected', 'credentials_missing'];
  ok('Supabase 집계 RPC — 아직 없으면 무엇을 하면 되는지 알린다',
    known.includes(met.data.error), `${met.data.error}: ${met.data.message}`);
} else {
  ok('Supabase 집계 RPC', typeof met.data.totals?.signups === 'number',
    `가입 ${met.data.totals?.signups} (전 기간 ${met.data.previous_period_totals?.signups})`);
  ok('원시 행이 섞여 오지 않는다',
    !JSON.stringify(met.data).includes('user_id') && !JSON.stringify(met.data).includes('@'),
    '집계값만');
}

// ── 3. GitHub
const dev = await call('get_dev_activity', { ...period, repo: REPO });
if (dev.isError) {
  ok('GitHub 개발 활동', false, `${dev.data.error}: ${dev.data.message}`);
} else {
  ok('GitHub 개발 활동', typeof dev.data.summary?.open_issue_count === 'number',
    `열린 이슈 ${dev.data.summary.open_issue_count}건 · 커밋 ${dev.data.commits?.count}건`
    + ` · PR ${dev.data.pull_requests?.length}건`);
}
const badRepo = await call('get_dev_activity', { ...period, repo: 'someone/else' });
ok('허용 목록 밖 저장소는 live 에서도 거절',
  badRepo.isError && badRepo.data.error === 'repo_not_allowed', badRepo.data.error);

// ── 4. web_search
const web = await call('web_search', { query: 'next.js 릴리스 보안 권고', max_results: 5 });
if (web.isError) {
  ok('의존성 릴리스·보안 권고', false, `${web.data.error}: ${web.data.message}`);
} else {
  const n = web.data.results?.length ?? 0;
  ok('의존성 릴리스·보안 권고', n > 0,
    `${n}건 · ${web.data.results?.[0]?.title?.slice(0, 50) ?? ''}`);
}

// ── 5. 근거 대조가 live 에서도 돈다
const invented = await call('render_chart', {
  card_no: 1, chart_type: 'bar', title: '지어낸 수치',
  source: { tool: 'get_system_health', field: 'summary' },
  data: [{ label: 'x', value: 987654 }],
});
ok('근거 없는 수치는 live 에서도 거절',
  invented.isError && invented.data.error === 'source_mismatch', invented.data.error);

if (!sys.isError) {
  const real = await call('render_chart', {
    card_no: 1, chart_type: 'bar', title: '배포 상태 (실제)',
    source: { tool: 'get_system_health', field: 'summary' },
    data: [
      { label: '전체', value: sys.data.summary.total },
      { label: '성공', value: sys.data.summary.ready },
      { label: '실패', value: sys.data.summary.error },
    ],
  });
  ok('실제 값으로 차트 생성', !real.isError && real.data.rendered_ok === true,
    real.isError ? real.data.error : `${real.data.svg_path} (${real.data.bytes}B)`);
}

// ── 6. 승인 토큰이 유효해도 실제 쓰기는 별도 스위치를 지난다
const token = mintToken('create_github_issue', REPO);
const write = await call('create_github_issue', {
  repo: REPO, title: '[스모크] 실제로 만들어지면 안 된다',
  body: '이 스모크는 쓰기 스위치가 꺼져 있음을 확인한다.', labels: ['ops'],
  source: { tool: 'get_system_health', field: 'summary' },
  approval_token: token,
});
ok('승인 토큰이 유효해도 쓰기 스위치 없이는 실제 이슈를 만들지 않는다',
  write.isError && write.data.error === 'live_writes_disabled', write.data.error);

// ── 7. live 모드에서 픽스처를 섞어 쓰지 못한다
const mixed = await call('get_system_health', { ...period, fixture_id: 'f1-normal' });
ok('live 모드에서 fixture_id 는 거절된다',
  mixed.isError && ['fixture_in_live_mode', 'fixture_conflict'].includes(mixed.data.error),
  mixed.data.error);

info('실행 기록', resolve(RUNS_DIR, RUN_ID, 'toolcalls.jsonl'));
console.log('─'.repeat(70));
console.log(process.exitCode ? '실패한 항목이 있다' : '전부 통과');
child.kill();
