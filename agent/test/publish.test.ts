/**
 * 검사: 발행 게이트 (DECISIONS.md D37~D41)
 *
 * 확인하는 것
 *   - 채택 기준은 도구 데이터에서 계산한다: 배포 실패 · 에러 증가 · 7일 넘은 이슈
 *   - 모르는 값(null)은 0 으로 읽지 않는다. 도구가 아예 성공하지 못했으면 tool_failed 로 멈춘다 (D43)
 *   - 도구마다 마지막으로 성공한 호출만 본다
 *   - 탈락 후보(카드 문장 기준)는 골라서 돌릴 수 있다 (비교표용). 기본 판정에는 들어가지 않는다
 *   - 대기 중인 건에만 답할 수 있고, 버전이 다르면 거절한다
 *   - 반려는 사유, 다시 판정은 지시가 필수다. 다시 판정은 두 번까지다
 *   - 나간 건은 다시 보내지 않는다
 *   - 슬랙 메시지는 블록 50개·글자 한도를 넘지 않는다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateGate, signalsFromToolcalls, relatedCards, initialPublishState, applyDecision, regate, beginSend, finishSend,
  applyEdits, buildSlackMessage, MAX_RETRY, SLACK_LIMITS, STALE_ISSUE_DAYS, GATE_RULES, CANDIDATE_RULES, NO_SIGNALS,
  type BriefingCard, type OpsSignals, type PublishState, type Transition,
} from '../src/publish.js';

const NOW = '2026-09-28T00:00:00.000Z';

function card(p: Partial<BriefingCard> & { card_no: number }): BriefingCard {
  return { kind: 'text', title: '제목', body: [], sources: ['get_system_health · summary'], accent: 'accent', ...p };
}

const COVER = card({ card_no: 1, kind: 'cover', title: '표지', body: ['추정 확인 못 함'] });
const FIX_OK = card({ card_no: 2, accent: 'bad', title: '배포 실패', body: ['dpl_b2 가 타입 오류로 실패했다'] });
const FIX_UNCERTAIN = card({ card_no: 2, accent: 'bad', title: '함수 오류 증가', body: ['dpl_b2 이후 오류가 늘었다 (추정)'] });
const FIX_NO_ID = card({ card_no: 3, accent: 'bad', title: '오류가 늘었다', body: ['오류가 많다'], sources: ['get_system_health · summary'] });
const WATCH_UNCERTAIN = card({ card_no: 4, accent: 'warn', body: ['원인은 확인 못 함'] });

const QUIET: OpsSignals = { deploy_failed: 0, errors_total: 0, errors_prev: 0, oldest_issue_days: 2, oldest_issue_number: 3, missing_tools: [] };
const sig = (p: Partial<OpsSignals>): OpsSignals => ({ ...QUIET, ...p });
const gate = (signals: OpsSignals, cards: BriefingCard[] = [COVER, FIX_OK]) => evaluateGate({ cards, signals });

function ok(t: Transition): PublishState {
  assert.equal(t.ok, true, t.ok ? '' : `${t.error}: ${t.message}`);
  return (t as { ok: true; state: PublishState }).state;
}

function errOf(t: Transition): string {
  assert.equal(t.ok, false);
  return (t as { ok: false; error: string }).error;
}

// ── 채택 기준: 도구 데이터 ────────────────────────────────

test('조용한 주는 멈추지 않는다 — 카드에 「추정」이 있어도 기본 판정은 문장을 보지 않는다', () => {
  const r = gate(QUIET, [COVER, FIX_UNCERTAIN, WATCH_UNCERTAIN]);
  assert.equal(r.stop, false);
  assert.equal(r.checked_cards, 2);   // 표지는 세지 않는다
});

test('배포가 하나라도 실패했으면 멈춘다 — deploy_failed', () => {
  const r = gate(sig({ deploy_failed: 1 }));
  assert.deepEqual(r.hits.map((h) => [h.rule, h.card_no]), [['deploy_failed', null]]);
  assert.match(r.hits[0]!.detail, /배포 실패 1건/);
});

test('앱 에러가 지난 기간보다 늘었으면 멈춘다 — errors_up. 같거나 줄면 멈추지 않는다', () => {
  assert.deepEqual(gate(sig({ errors_total: 4, errors_prev: 0 })).hits.map((h) => h.rule), ['errors_up']);
  assert.equal(gate(sig({ errors_total: 4, errors_prev: 4 })).stop, false);
  assert.equal(gate(sig({ errors_total: 0, errors_prev: 4 })).stop, false);
});

test(`열린 이슈가 ${STALE_ISSUE_DAYS}일 넘게 방치되면 멈춘다 — stale_issue (경계 포함)`, () => {
  assert.equal(gate(sig({ oldest_issue_days: STALE_ISSUE_DAYS - 1 })).stop, false);
  const r = gate(sig({ oldest_issue_days: STALE_ISSUE_DAYS, oldest_issue_number: 16 }));
  assert.deepEqual(r.hits.map((h) => h.rule), ['stale_issue']);
  assert.match(r.hits[0]!.detail, /#16 7일째/);
});

test('모르는 값은 0 으로 읽지 않는다 — 도구는 성공했는데 값이 없으면 그 기준만 걸리지 않는다', () => {
  assert.equal(gate(sig({ deploy_failed: null, errors_total: null, errors_prev: null, oldest_issue_days: null })).stop, false);
  // 전주 값이 없으면 늘었는지 알 수 없다
  assert.equal(gate(sig({ errors_total: 9, errors_prev: null })).stop, false);
});

test('도구 하나라도 성공한 조회가 없으면 멈춘다 — tool_failed (D43)', () => {
  const r = gate(sig({ missing_tools: ['get_dev_activity'], oldest_issue_days: null }));
  assert.deepEqual(r.hits.map((h) => h.rule), ['tool_failed']);
  assert.match(r.hits[0]!.detail, /get_dev_activity/);
  // 도구 기록이 아예 없으면 셋 다 성공하지 못한 것이다
  assert.deepEqual(gate(NO_SIGNALS).hits.map((h) => h.rule), ['tool_failed']);
});

test('실패한 호출만 있는 도구도 성공하지 못한 것이다 — 마지막 성공이 없으면 missing', () => {
  const s = signalsFromToolcalls([
    { tool: 'get_system_health', ok: true, output: { summary: { error: 0 } } },
    { tool: 'get_user_metrics', ok: true, output: { totals: {} } },
    { tool: 'get_dev_activity', ok: false, output: { error: 'rate_limited' } },
  ]);
  assert.deepEqual(s.missing_tools, ['get_dev_activity']);
});

test('여러 기준에 걸리면 모두 적는다', () => {
  const r = gate(sig({ deploy_failed: 2, errors_total: 6, errors_prev: 1, oldest_issue_days: 9 }));
  assert.deepEqual(r.hits.map((h) => h.rule), ['deploy_failed', 'errors_up', 'stale_issue']);
});

test('멈춘 이유에는 출처 코드를 붙이지 않는다 — 출처는 판정에 쓴 값 쪽에 있다', () => {
  const r = gate(sig({ deploy_failed: 1, errors_total: 6, errors_prev: 1, oldest_issue_days: 9, oldest_issue_number: 16 }));
  for (const h of r.hits) assert.doesNotMatch(h.detail, /get_|—/, h.detail);
});

// ── 관련 카드 ──────────────────────────────────────────

test('관련 카드 — 기준의 도구를 근거로 들거나 그 축을 말하는 카드를 짚는다', () => {
  const cards = [
    COVER,
    card({ card_no: 2, title: '배포 실패', body: ['dpl_b2 실패'], sources: ['get_system_health · summary'] }),
    card({ card_no: 3, title: '가입 추이', body: ['가입 19명'], sources: ['get_user_metrics · totals.signups'] }),
    card({ card_no: 4, title: '에러 늘었다', body: ['/wish 6건'], sources: ['get_user_metrics · totals.errors_total'] }),
    card({ card_no: 5, title: '개발 활동', body: ['GitHub 조회 실패로 확인 못 함'], sources: ['web_search · results'] }),
  ];
  const signals = sig({ deploy_failed: 1, errors_total: 6, errors_prev: 1, missing_tools: ['get_dev_activity'] });
  const r = evaluateGate({ cards, signals });
  const rel = relatedCards({ cards, signals }, r.hits);
  assert.deepEqual(rel.map((x) => x.card_no), [2, 4, 5]);
  assert.deepEqual(rel.find((x) => x.card_no === 5)?.rules, ['tool_failed']);
  assert.equal(rel.some((x) => x.card_no === 3), false, '가입 카드는 에러 기준과 관련이 없다');
});

// ── 도구 기록에서 신호 뽑기 ───────────────────────────────

test('도구 기록에서 신호를 뽑는다 — 마지막으로 성공한 호출만 본다', () => {
  const s = signalsFromToolcalls([
    { tool: 'get_system_health', ok: true, output: { summary: { total: 3, ready: 3, error: 0 } } },
    { tool: 'get_system_health', ok: true, output: { summary: { total: 3, ready: 2, error: 1 } } },
    { tool: 'get_system_health', ok: false, output: { error: 'timeout' } },   // 실패는 무시
    { tool: 'get_user_metrics', ok: true, output: {
      totals: { errors_total: 6 }, previous_period_totals: { errors_total: 1 } } },
    { tool: 'get_dev_activity', ok: true, output: {
      summary: { oldest_open_issue_days: 9 },
      open_issues: [{ number: 11, age_days: 2 }, { number: 16, age_days: 9 }] } },
    { tool: 'web_search', ok: true, output: { results: [] } },
  ]);
  assert.deepEqual(s, { deploy_failed: 1, errors_total: 6, errors_prev: 1, oldest_issue_days: 9, oldest_issue_number: 16, missing_tools: [] });
});

test('전주 비교값이 null 이면 errors_prev 도 null 이다 — 0 이 아니다', () => {
  const s = signalsFromToolcalls([
    { tool: 'get_user_metrics', ok: true, output: { totals: { errors_total: 3 }, previous_period_totals: null } },
  ]);
  assert.equal(s.errors_total, 3);
  assert.equal(s.errors_prev, null);
  assert.equal(s.deploy_failed, null);   // 부르지 않은 도구
  assert.deepEqual(s.missing_tools, ['get_system_health', 'get_dev_activity']);
});

// ── 탈락 후보: 카드 문장 기준 (비교표용) ──────────────────

const text = (cards: BriefingCard[], rules: ('fix_uncertain' | 'fix_no_identifier')[] = ['fix_uncertain', 'fix_no_identifier']) =>
  evaluateGate({ cards, signals: QUIET }, { rules });

test('탈락 후보 fix_uncertain — 「손봐야 할 것」 카드의 추정·확인 못 함 (띄어쓰기 무관)', () => {
  assert.deepEqual(text([COVER, FIX_UNCERTAIN]).hits.map((h) => [h.rule, h.card_no]), [['fix_uncertain', 2]]);
  assert.equal(text([card({ card_no: 2, accent: 'bad', body: ['dpl_x1 원인 확인못함'] })]).hits[0]?.rule, 'fix_uncertain');
  assert.equal(text([COVER, FIX_OK, WATCH_UNCERTAIN]).stop, false);
});

test('탈락 후보 fix_no_identifier — 식별자 종류와 숫자만 있는 값', () => {
  assert.deepEqual(text([FIX_NO_ID]).hits.map((h) => h.rule), ['fix_no_identifier']);
  for (const id of ['dpl_a1', 'commit 3f9c2ab', '이슈 #13', 'GHSA-9qv8-xxxx', 'CVE-2025-29927']) {
    assert.equal(text([card({ card_no: 2, accent: 'bad', body: [`참고 ${id}`] })]).stop, false, id);
  }
  assert.deepEqual(text([card({ card_no: 2, accent: 'bad', body: ['오류 1000000건'] })]).hits.map((h) => h.rule), ['fix_no_identifier']);
});

test('탈락 후보도 분류 칸(category)을 색보다 먼저 본다 (D40)', () => {
  assert.equal(text([card({ card_no: 2, category: 'fix_now', accent: undefined, body: ['원인 추정'] })], ['fix_uncertain']).stop, true);
  assert.equal(text([card({ card_no: 3, category: 'watch', accent: 'bad', body: ['원인 추정'] })]).stop, false);
});

test('규칙을 고르지 않으면 채택 기준만 돈다. 빈 목록이면 아무것도 멈추지 않는다', () => {
  const heavy = sig({ deploy_failed: 1 });
  assert.equal(evaluateGate({ cards: [FIX_UNCERTAIN], signals: heavy }, { rules: [] }).stop, false);
  assert.deepEqual(evaluateGate({ cards: [FIX_UNCERTAIN], signals: heavy }).hits.map((h) => h.rule), ['deploy_failed']);
});

test('모든 규칙에 막으려는 위험이 적혀 있다', () => {
  for (const r of [...GATE_RULES, ...CANDIDATE_RULES]) assert.ok(r.label && r.risk, r.id);
});

// ── 상태 전이 ────────────────────────────────────────────

const STOPPED = initialPublishState(gate(sig({ deploy_failed: 1 })), NOW);
const PASSED = initialPublishState(gate(QUIET), NOW);

test('걸린 건은 대기, 안 걸린 건은 바로 보낼 수 있는 상태로 시작한다', () => {
  assert.equal(STOPPED.route, 'review');
  assert.equal(STOPPED.status, 'pending_review');
  assert.equal(PASSED.route, 'auto');
  assert.equal(PASSED.status, 'approved');
});

test('승인하면 approved 가 되고 버전이 오른다', () => {
  const s = ok(applyDecision(STOPPED, { action: 'approve', version: 1 }, NOW));
  assert.equal(s.status, 'approved');
  assert.equal(s.version, 2);
  assert.equal(s.decisions.length, 1);
});

test('화면이 본 버전과 다르면 거절한다', () => {
  assert.equal(errOf(applyDecision(STOPPED, { action: 'approve', version: 9 }, NOW)), 'stale_version');
});

test('대기 중이 아닌 건에는 답하지 않는다', () => {
  assert.equal(errOf(applyDecision(PASSED, { action: 'approve', version: 1 }, NOW)), 'invalid_transition');
});

test('반려는 사유가 있어야 한다', () => {
  assert.equal(errOf(applyDecision(STOPPED, { action: 'reject', version: 1, reason: '  ' }, NOW)), 'reason_required');
  const s = ok(applyDecision(STOPPED, { action: 'reject', version: 1, reason: '원인 단정' }, NOW));
  assert.equal(s.status, 'rejected');
  assert.equal(s.decisions[0]?.reason, '원인 단정');
});

test('수정 후 승인은 고친 카드를 남기고, 같은 카드를 또 고치면 합친다', () => {
  const s1 = ok(applyDecision(STOPPED, { action: 'edit', version: 1, edits: [{ card_no: 2, title: '새 제목' }] }, NOW));
  assert.equal(s1.status, 'approved');
  assert.deepEqual(s1.edits, [{ card_no: 2, title: '새 제목' }]);
  assert.equal(errOf(applyDecision(STOPPED, { action: 'edit', version: 1, edits: [] }, NOW)), 'edits_required');
});

test('다시 판정은 지시가 필요하고, 두 번까지만 된다', () => {
  assert.equal(errOf(applyDecision(STOPPED, { action: 'retry', version: 1, instruction: '' }, NOW)), 'instruction_required');
  let s = STOPPED;
  for (let i = 0; i < MAX_RETRY; i++) {
    s = ok(applyDecision(s, { action: 'retry', version: s.version, instruction: '부분만 다시' }, NOW));
    assert.equal(s.status, 'retrying');
    s = ok(regate(s, gate(QUIET), NOW));
    // 사람이 고치라고 한 건이므로 기준에 안 걸려도 다시 사람에게 보인다
    assert.equal(s.status, 'pending_review');
  }
  assert.equal(s.retries, MAX_RETRY);
  assert.equal(errOf(applyDecision(s, { action: 'retry', version: s.version, instruction: '한 번 더' }, NOW)), 'retry_limit');
});

test('대기 중에 다시 판정하면 대기로 남고, 고친 내용은 지우지 않는다', () => {
  const edited = { ...STOPPED, edits: [{ card_no: 2, title: 't' }] };
  const s = ok(regate(edited, gate(QUIET), NOW));
  assert.equal(s.status, 'pending_review');
  assert.equal(s.gate.stop, false);
  assert.deepEqual(s.edits, [{ card_no: 2, title: 't' }]);
  assert.equal(errOf(regate(PASSED, gate(QUIET), NOW)), 'invalid_transition');
});

test('나간 건은 다시 보내지 않는다. 실패한 건은 다시 보낼 수 있다', () => {
  const sending = ok(beginSend(PASSED, NOW));
  assert.equal(sending.status, 'sending');
  assert.equal(errOf(beginSend(sending, NOW)), 'invalid_transition');   // 보내는 중 두 번째 클릭

  const failed = ok(finishSend(sending, { ok: false, error: 'HTTP 500' }, NOW));
  assert.equal(failed.status, 'send_failed');
  const again = ok(beginSend(failed, NOW));
  assert.equal(again.error, undefined);                                  // 지난 오류는 지운다

  const published = ok(finishSend(again, { ok: true, dry_run: true }, NOW));
  assert.equal(published.status, 'published');
  assert.equal(published.sent?.dry_run, true);
  assert.equal(errOf(beginSend(published, NOW)), 'invalid_transition');
  assert.equal(errOf(applyDecision(published, { action: 'approve', version: published.version }, NOW)), 'invalid_transition');
});

test('반려된 건은 보내지 않는다', () => {
  const s = ok(applyDecision(STOPPED, { action: 'reject', version: 1, reason: 'x' }, NOW));
  assert.equal(errOf(beginSend(s, NOW)), 'invalid_transition');
});

test('고친 내용은 원본 카드 위에 덮이고 원본은 그대로다', () => {
  const orig = [FIX_UNCERTAIN];
  const out = applyEdits(orig, [{ card_no: 2, body: ['고친 본문'] }]);
  assert.deepEqual(out[0]?.body, ['고친 본문']);
  assert.equal(out[0]?.title, FIX_UNCERTAIN.title);
  assert.deepEqual(orig[0]?.body, FIX_UNCERTAIN.body);
});

test('지운 카드는 보내지 않는다 — 원본 배열은 그대로다', () => {
  const orig = [COVER, FIX_OK, WATCH_UNCERTAIN];
  const out = applyEdits(orig, [{ card_no: 4, remove: true }]);
  assert.deepEqual(out.map((c) => c.card_no), [1, 2]);
  assert.equal(orig.length, 3);
  const m = buildSlackMessage(out, { heading: 'h' });
  assert.match(m.text, /카드 1장/);
});

test('지웠다가 되살리면(remove: false) 다시 보낸다 — 같은 카드의 고침은 합쳐진다', () => {
  let s = ok(applyDecision(STOPPED, { action: 'edit', version: 1, edits: [{ card_no: 4, remove: true }] }, NOW));
  assert.deepEqual(s.edits, [{ card_no: 4, remove: true }]);
  // 대기로 되돌린 뒤 다시 고치는 경우를 흉내 낸다
  s = { ...s, status: 'pending_review' };
  s = ok(applyDecision(s, { action: 'edit', version: s.version, edits: [{ card_no: 4, remove: false, title: 't' }] }, NOW));
  assert.deepEqual(applyEdits([FIX_OK, WATCH_UNCERTAIN], s.edits).map((c) => c.card_no), [2, 4]);
});

// ── 슬랙 메시지 ──────────────────────────────────────────

test('카드마다 심각도 표시를 붙이고 표지는 넣지 않는다', () => {
  const m = buildSlackMessage([COVER, FIX_OK, WATCH_UNCERTAIN, card({ card_no: 5 })], { heading: '주간 운영 브리핑' });
  const texts = m.blocks.filter((b) => b.type === 'section').map((b) => (b.text as { text: string }).text);
  assert.equal(texts.length, 3);
  assert.ok(texts[0]!.startsWith('🔴'));
  assert.ok(texts[1]!.startsWith('🟡'));
  assert.ok(texts[2]!.startsWith('🔵'));
  assert.match(m.text, /카드 3장 · 손봐야 할 것 1/);
});

test('슬랙 제어 문자 &, <, > 를 바꿔 쓴다', () => {
  const m = buildSlackMessage([card({ card_no: 2, title: 'a<b>&c' })], { heading: 'h' });
  const t = (m.blocks[1]!.text as { text: string }).text;
  assert.match(t, /a&lt;b&gt;&amp;c/);
});

test('블록 50개와 글자 한도를 넘지 않는다', () => {
  const many = Array.from({ length: 40 }, (_, i) => card({ card_no: i + 2, body: ['가'.repeat(5000)] }));
  const m = buildSlackMessage(many, { heading: '긴 제목'.repeat(100), footer: 'f' });
  assert.ok(m.blocks.length <= SLACK_LIMITS.blocks, `blocks=${m.blocks.length}`);
  const header = m.blocks[0]!.text as { text: string };
  assert.ok(header.text.length <= SLACK_LIMITS.headerText);
  for (const b of m.blocks.filter((x) => x.type === 'section')) {
    assert.ok(((b.text as { text: string }).text).length <= SLACK_LIMITS.sectionText);
  }
  assert.ok(m.blocks.some((b) => b.type === 'section' && /…외 \d+장/.test((b.text as { text: string }).text)));
});
