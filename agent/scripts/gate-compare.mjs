#!/usr/bin/env node
/**
 * 멈춤 기준 비교표 — 같은 브리핑들을 기준 조합별로 판정해 개입률·놓침·헛멈춤을 센다.
 *
 *   node scripts/gate-compare.mjs                   # 기준을 만든 세트 (dev)
 *   node scripts/gate-compare.mjs --set holdout     # D41 뒤 새 실행 4편 — 정답은 실행 전에 정했다 (D43 을 만드는 데 썼다)
 *   node scripts/gate-compare.mjs --set validation  # D43 뒤 새 실행 — 기준을 고치는 데 쓰지 않은 유일한 세트
 *
 * 실제 운영 데이터로 돌린 8편(dev 6 · validation 2)은 저장소에 넣지 않았다 (D46). 폴더가 있는 것만 센다 —
 * 정답 라벨 파일에는 그 8편의 라벨이 기록으로 남아 있지만 여기서는 쓰이지 않는다.
 *   node scripts/gate-compare.mjs --detail          # 브리핑마다 어느 기준에 걸렸는지
 *
 * 데이터: fixtures/publish-gate/{run}/cards/*.json · toolcalls.jsonl (세 도구의 성공한 호출만)
 * 정답:   fixtures/publish-gate/labels.json 의 should_stop (사람이 채운다)
 * 정답이 비어 있으면 놓침·헛멈춤은 셀 수 없어 「—」로 둔다. 개입률은 정답 없이도 나온다.
 *
 * 판정은 dist/src/publish.js 의 evaluateGate 를 그대로 쓴다 — 앱과 같은 규칙이다.
 * 채택 기준은 도구 데이터 기준 3개다 (D41). 카드 문장 기준·「FIX 있음」「확인 못 함」은
 * 탈락시킨 후보라 비교용으로만 센다.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGate, isFixNow, signalsFromToolcalls } from '../dist/src/publish.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = join(ROOT, 'fixtures', 'publish-gate');
const detail = process.argv.includes('--detail');
const setArg = process.argv.indexOf('--set');
const SET = setArg > 0 ? process.argv[setArg + 1] : 'dev';
if (!['dev', 'holdout', 'validation'].includes(SET)) throw new Error(`--set 은 dev · holdout · validation 중 하나다: ${SET}`);
const DATA = SET === 'dev' ? BASE : join(BASE, SET);

const labels = SET === 'dev'
  ? JSON.parse(readFileSync(join(BASE, 'labels.json'), 'utf8')).runs ?? {}
  : SET === 'holdout'
    ? JSON.parse(readFileSync(join(BASE, 'holdout-labels.json'), 'utf8')).fixtures ?? {}
    : JSON.parse(readFileSync(join(BASE, 'validation-labels.json'), 'utf8')).runs ?? {};
const runs = readdirSync(DATA, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(DATA, d.name, 'cards')))
  .map((d) => d.name)
  .sort();

function loadSignals(run) {
  const p = join(DATA, run, 'toolcalls.jsonl');
  if (!existsSync(p)) return signalsFromToolcalls([]);
  return signalsFromToolcalls(readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

function loadCards(run) {
  const dir = join(DATA, run, 'cards');
  return readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

const body = (cards) => cards.filter((c) => c.kind !== 'cover');
const text = (c) => [c.title, ...(c.body ?? [])].join('\n');

// 위에서 아래로 갈수록 빡빡해진다 (3강 CRITERIA 와 같은 모양).
const CRITERIA = [
  ['기준 없음 (전부 자동)', () => false],
  ['배포 실패만', (d) => evaluateGate(d, { rules: ['deploy_failed'] }).stop],
  ['에러 증가만', (d) => evaluateGate(d, { rules: ['errors_up'] }).stop],
  ['방치 이슈만', (d) => evaluateGate(d, { rules: ['stale_issue'] }).stop],
  ['도구 실패만', (d) => evaluateGate(d, { rules: ['tool_failed'] }).stop],
  ['D41: 배포 실패 ∪ 에러 증가 ∪ 방치 이슈', (d) => evaluateGate(d, { rules: ['deploy_failed', 'errors_up', 'stale_issue'] }).stop],
  ['채택 D43: D41 ∪ 도구 실패', (d) => evaluateGate(d).stop],
  ['(탈락) FIX+불확실 ∪ 식별자 없음', (d) => evaluateGate(d, { rules: ['fix_uncertain', 'fix_no_identifier'] }).stop],
  // 분류 칸(category)이 정본이고, 칸이 없는 옛 카드는 색으로 본다 — 게이트와 같은 판정 (D40).
  ['(탈락) FIX 카드 있음', (d) => body(d.cards).some(isFixNow)],
  ['(탈락) 확인 못 함 1곳 이상', (d) => body(d.cards).some((c) => /확인 ?못/.test(text(c)))],
  ['전부 멈춤', () => true],
];

const data = runs.map((run) => ({ run, cards: loadCards(run), signals: loadSignals(run), label: labels[run]?.should_stop ?? null }));
const labeled = data.filter((d) => typeof d.label === 'boolean').length;

function pad(s, n) {
  // 한글은 두 칸으로 센다 — 표가 어긋나지 않게.
  const w = [...String(s)].reduce((a, ch) => a + (/[ㄱ-힣]/.test(ch) ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
}

console.log(`[${SET}] 브리핑 ${data.length}편 · 정답 라벨 ${labeled}/${data.length}\n`);
console.log(`${pad('멈춤 기준', 46)}${pad('개입률', 10)}${pad('놓침', 8)}헛멈춤`);
console.log('─'.repeat(74));
for (const [name, stops] of CRITERIA) {
  let stopped = 0, missed = 0, falseStop = 0;
  for (const d of data) {
    const s = stops(d);
    if (s) stopped++;
    if (d.label === true && !s) missed++;
    if (d.label === false && s) falseStop++;
  }
  const m = labeled ? `${missed}건` : '—';
  const f = labeled ? `${falseStop}건` : '—';
  console.log(`${pad(name, 46)}${pad(`${stopped}/${data.length}`, 10)}${pad(m, 8)}${f}`);
}
if (labeled < data.length) {
  console.log(`\n정답이 없는 ${data.length - labeled}편은 놓침·헛멈춤에서 빠진다 (labels.json 을 채우면 셈에 들어간다).`);
}

if (detail) {
  console.log('\n브리핑별 판정 (채택 기준)');
  for (const d of data) {
    const r = evaluateGate(d);
    const mark = r.stop ? '멈춤' : '자동';
    const lab = d.label === null ? '정답 없음' : d.label ? '정답: 봐야 함' : '정답: 안 봐도 됨';
    console.log(`\n  ${d.run} — ${mark} · ${lab}`);
    const sg = d.signals;
    console.log(`    신호: 배포 실패 ${sg.deploy_failed ?? '모름'} · 에러 ${sg.errors_prev ?? '모름'}→${sg.errors_total ?? '모름'} · 가장 오래된 이슈 ${sg.oldest_issue_days == null ? '모름' : sg.oldest_issue_days + '일'} · 성공 못 한 도구 ${sg.missing_tools.join(', ') || '없음'}`);
    for (const h of r.hits) console.log(`    · [${h.rule}] ${h.card_no === null ? '' : `${h.card_no}번 `}${h.detail}`);
  }
}
