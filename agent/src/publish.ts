/**
 * 발행 게이트 — 브리핑을 슬랙에 내보내기 직전의 멈춤 기준과 상태 전이 (DECISIONS.md D37~D41).
 *
 * 이 파일은 **순수 함수만** 둔다. 파일을 읽거나 네트워크를 부르지 않는다.
 *   - 앱(app/lib/publish.ts)은 이 함수들로 판정하고, 결과를 runs/{id}/publish.json 에 쓴다
 *   - 비교표 스크립트(scripts/gate-compare.mjs)는 같은 규칙으로 개입률·놓침·헛멈춤을 센다
 * 화면·REPORT·비교표가 **같은 규칙 문장**을 쓰게 하려고 규칙 설명(label·risk)도 여기에 둔다.
 *
 * 단위는 브리핑 한 편이다. 기준 하나라도 걸리면 편 전체가 사람에게 간다.
 *
 * 기준은 **카드 문장이 아니라 도구가 가져온 원래 데이터**에서 계산한다 (D41).
 * 카드 문장(「추정」이 있나, 식별자가 있나)으로 판정했더니 사람이 붙인 정답과
 * 놓침 3·헛멈춤 2 로 어긋났다. 사람은 「그 주에 우리 앱 안에서 무슨 일이 있었나」를 봤다.
 */

/** runs/{id}/cards/NN.json 한 장. 게이트가 보는 칸만 적는다. */
export type BriefingCard = {
  card_no: number;
  kind: 'cover' | 'metric' | 'text';
  title: string;
  body: string[];
  sources: string[];
  /**
   * 브리핑 분류 (D40). compose_card 가 필수로 받는다. 이 칸이 생기기 전 카드에는 없어서
   * 그때는 색(accent)으로 본다 — bad = 지금 손봐야 할 것 (app/lib/derive.ts 와 같은 매핑).
   */
  category?: 'fix_now' | 'watch' | 'fyi';
  accent?: 'accent' | 'warn' | 'bad';
};

/**
 * 도구가 가져온 값에서 뽑은 운영 신호. **모르면 null** 이다 — 0 과 구별한다.
 * 결측이면 그 기준은 걸리지 않는다. 이 약점은 D41 에 적었다.
 */
export type OpsSignals = {
  /** get_system_health · summary.error — 이번 기간 실패한 배포 수. */
  deploy_failed: number | null;
  /** get_user_metrics · totals.errors_total / previous_period_totals.errors_total */
  errors_total: number | null;
  errors_prev: number | null;
  /** get_dev_activity · summary.oldest_open_issue_days 와 그 이슈 번호. */
  oldest_issue_days: number | null;
  oldest_issue_number: number | null;
  /**
   * 세 도구 중 **한 번도 성공하지 못한** 것 (실패했거나 부르지 않았다). 비어 있지 않으면
   * 위 값 중 일부는 「모름」이다 — 그 축의 사고를 볼 수 없었다는 뜻이다 (D43).
   */
  missing_tools: SignalTool[];
};

/** 게이트가 신호를 뽑는 세 도구. */
export const SIGNAL_TOOLS = ['get_system_health', 'get_user_metrics', 'get_dev_activity'] as const;
export type SignalTool = typeof SIGNAL_TOOLS[number];

/** 도구 기록이 하나도 없을 때. 세 도구 모두 성공하지 못한 것으로 본다. */
export const NO_SIGNALS: OpsSignals = {
  deploy_failed: null, errors_total: null, errors_prev: null, oldest_issue_days: null, oldest_issue_number: null,
  missing_tools: [...SIGNAL_TOOLS],
};

/** runs/{id}/toolcalls.jsonl 한 줄. 게이트가 보는 칸만 적는다. */
export type ToolcallRecord = { tool: string; ok?: boolean; output?: unknown };

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
}

/** 도구마다 **마지막으로 성공한** 호출의 출력에서 신호를 뽑는다. 실패한 호출은 보지 않는다. */
export function signalsFromToolcalls(records: readonly ToolcallRecord[]): OpsSignals {
  const last = new Map<string, Record<string, unknown>>();
  for (const r of records) if (r.ok !== false && r.output) last.set(r.tool, obj(r.output));
  const health = last.get('get_system_health') ?? {};
  const metrics = last.get('get_user_metrics') ?? {};
  const dev = last.get('get_dev_activity') ?? {};

  const issues = Array.isArray(dev.open_issues) ? dev.open_issues.map(obj) : [];
  const oldest = issues.reduce<Record<string, unknown> | null>(
    (a, b) => (a && (num(a.age_days) ?? -1) >= (num(b.age_days) ?? -1) ? a : b), null);

  return {
    deploy_failed: num(obj(health.summary).error),
    errors_total: num(obj(metrics.totals).errors_total),
    // previous_period_totals 가 null 이면 비교할 수 없다 — 0 으로 두지 않는다.
    errors_prev: metrics.previous_period_totals ? num(obj(metrics.previous_period_totals).errors_total) : null,
    oldest_issue_days: num(obj(dev.summary).oldest_open_issue_days),
    oldest_issue_number: oldest ? num(oldest.number) : null,
    missing_tools: SIGNAL_TOOLS.filter((t) => !last.has(t)),
  };
}

export type GateInput = { cards: BriefingCard[]; signals: OpsSignals };

/** 채택한 기준 (D41 · D43). */
export type AdoptedRuleId = 'deploy_failed' | 'errors_up' | 'stale_issue' | 'tool_failed';
/** 비교표에만 남긴 탈락 후보 (D38 → D41). */
export type CandidateRuleId = 'fix_uncertain' | 'fix_no_identifier';
export type GateRuleId = AdoptedRuleId | CandidateRuleId;

export type GateHit = {
  rule: GateRuleId;
  /** 카드에서 걸렸으면 그 번호, 브리핑 전체의 데이터에서 걸렸으면 null. */
  card_no: number | null;
  detail: string;
};

export type GateRule = {
  id: GateRuleId;
  /** 무엇을 보면 멈추는가. 한 줄. */
  label: string;
  /** 이 기준이 막으려는 위험. 승인 화면의 「멈춘 이유」와 REPORT 에 그대로 쓴다. */
  risk: string;
  check: (input: GateInput) => GateHit[];
};

export type GateResult = { stop: boolean; hits: GateHit[]; checked_cards: number };

/** 브리핑 주기와 같다 — 지난주 브리핑 때도 열려 있던 이슈. */
export const STALE_ISSUE_DAYS = 7;

export const GATE_RULES: readonly GateRule[] = [
  {
    id: 'deploy_failed',
    label: '이번 기간에 실패한 배포가 있다',
    risk: '사용자가 겪었을 수 있는 장애다. 확인 없이 알림 한 줄로 흘려보내면 원인·복구 여부가 틀린 채로 팀에 퍼진다.',
    check: ({ signals: s }) => (s.deploy_failed ?? 0) >= 1
      ? [{ rule: 'deploy_failed', card_no: null, detail: `배포 실패 ${s.deploy_failed}건` }]
      : [],
  },
  {
    id: 'errors_up',
    label: '앱 에러가 지난 기간보다 늘었다',
    risk: '조용히 늘어나는 에러다. 원인을 모른 채 숫자만 퍼지면 엉뚱한 곳을 의심하거나, 반대로 아무도 손대지 않는다.',
    check: ({ signals: s }) => s.errors_total !== null && s.errors_prev !== null && s.errors_total > s.errors_prev
      ? [{ rule: 'errors_up', card_no: null, detail: `앱 에러 ${s.errors_prev}→${s.errors_total}건` }]
      : [],
  },
  {
    id: 'stale_issue',
    label: `열린 이슈가 ${STALE_ISSUE_DAYS}일 넘게 방치돼 있다`,
    risk: '지난 브리핑 때도 열려 있던 문제다. 매주 같은 알림으로 반복되면 무뎌진다. 누가 맡을지 사람이 정하고 내보낸다.',
    check: ({ signals: s }) => (s.oldest_issue_days ?? 0) >= STALE_ISSUE_DAYS
      ? [{ rule: 'stale_issue', card_no: null,
          detail: `가장 오래 열린 이슈 ${s.oldest_issue_number !== null ? `#${s.oldest_issue_number} ` : ''}${s.oldest_issue_days}일째` }]
      : [],
  },
  {
    id: 'tool_failed',
    label: '운영 데이터를 가져오는 도구 중 한 번도 성공하지 못한 것이 있다',
    risk: '그 축의 사고를 볼 수 없었다. 나머지 기준이 조용한 것은 「문제가 없어서」가 아니라 「모르기 때문」일 수 있다. 확인 없이 내보내면 모르는 것을 괜찮다고 알리는 셈이다.',
    check: ({ signals: s }) => s.missing_tools.length
      ? [{ rule: 'tool_failed', card_no: null, detail: `성공한 조회가 없는 도구: ${s.missing_tools.join(', ')}` }]
      : [],
  },
];

// ── 탈락 후보: 카드 문장으로 판정하는 기준 (D38 에서 채택했다가 D41 에서 뺐다) ──

// 「추정」「확인 못 함」은 카드 본문에 글자로만 들어 있다 — 따로 저장된 칸이 없다.
const UNCERTAIN = /추정|확인 ?못/;

// 사람이 찾아갈 수 있는 식별자. 배포 ID · 커밋 SHA · 이슈 번호 · 보안 권고 번호.
// SHA 는 a~f 가 하나는 섞여야 한다 — 1000000 같은 숫자를 커밋으로 읽지 않게.
const IDENTIFIER = /\bdpl_[A-Za-z0-9]+|\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|#\d+|GHSA-[\w-]+|CVE-\d{4}-\d+/;

/** 분류 칸이 있으면 그것이 정본이다. 없으면(옛 카드) 색으로 본다. */
export function isFixNow(card: BriefingCard): boolean {
  if (card.kind === 'cover') return false;
  return card.category ? card.category === 'fix_now' : card.accent === 'bad';
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').trim();
}

function perFixCard(input: GateInput, rule: CandidateRuleId, f: (c: BriefingCard) => string | null): GateHit[] {
  return input.cards.filter(isFixNow).flatMap((c) => {
    const d = f(c);
    return d ? [{ rule, card_no: c.card_no, detail: d }] : [];
  });
}

export const CANDIDATE_RULES: readonly GateRule[] = [
  {
    id: 'fix_uncertain',
    label: '「지금 손봐야 할 것」 카드에 「추정」 또는 「확인 못 함」이 있다',
    risk: '받는 사람이 곧바로 손을 대는 카드다. 근거가 불확실한 채로 나가면 틀린 원인을 고치러 간다.',
    check: (input) => perFixCard(input, 'fix_uncertain', (c) => {
      const m = [c.title, ...c.body].join('\n').match(UNCERTAIN);
      return m ? `「${m[0]}」 표현이 있다 - ${oneLine(c.title)}` : null;
    }),
  },
  {
    id: 'fix_no_identifier',
    label: '「지금 손봐야 할 것」 카드에 찾아갈 식별자(배포 ID·커밋·이슈 번호·보안 권고)가 없다',
    risk: '무엇을 고치라는지 가리키지 못하는 경고다. 받는 사람이 원래 화면을 다시 뒤져야 해서 알림이 소음이 된다.',
    check: (input) => perFixCard(input, 'fix_no_identifier', (c) =>
      IDENTIFIER.test([...c.body, ...c.sources].join('\n')) ? null : `식별자가 없다 - ${oneLine(c.title)}`),
  },
];

const ALL_RULES: readonly GateRule[] = [...GATE_RULES, ...CANDIDATE_RULES];

/**
 * 브리핑 한 편을 판정한다. 기본은 채택한 기준(GATE_RULES)이다.
 * rules 를 넘기면 그 조합으로만 본다 — 탈락 후보까지 섞어 비교표를 만들 때 쓴다.
 */
export function evaluateGate(input: GateInput, opts: { rules?: readonly GateRuleId[] } = {}): GateResult {
  const active = opts.rules ? ALL_RULES.filter((r) => opts.rules!.includes(r.id)) : GATE_RULES;
  const cards = input.cards.filter((c) => c.kind !== 'cover');
  const hits = active.flatMap((r) => r.check({ ...input, cards }));
  return { stop: hits.length > 0, hits, checked_cards: cards.length };
}

/** 기준마다 그 기준이 보는 도구와, 카드 글에서 그 축을 알아볼 낱말. 화면이 관련 카드를 짚는 데만 쓴다. */
const RULE_TOPIC: Record<AdoptedRuleId, { tool: SignalTool; field?: RegExp; words: RegExp }> = {
  deploy_failed: { tool: 'get_system_health', field: /deploy|summary/i, words: /배포|빌드|deploy|dpl_/i },
  errors_up: { tool: 'get_user_metrics', field: /error/i, words: /에러|오류|error/i },
  stale_issue: { tool: 'get_dev_activity', field: /issue/i, words: /이슈|issue/i },
  tool_failed: { tool: 'get_dev_activity', words: /확인 ?못|조회 ?(불가|실패|안 ?됨)|unavailable/i },
};
const TOOL_WORDS: Record<SignalTool, RegExp> = {
  get_system_health: /배포|시스템|함수 ?오류|deploy/i,
  get_user_metrics: /사용자|가입|활성|지표|에러/i,
  get_dev_activity: /개발|커밋|이슈|PR|GitHub/i,
};

/**
 * 판정에서 걸린 기준과 관련된 카드 번호. 데이터 기준(D41·D43)은 카드가 아니라 브리핑 전체에서 걸리므로,
 * 그 기준의 도구를 근거로 든 카드, 또는 그 축을 말하는 카드를 짚는다. 사람이 **어느 카드를 봐야 하는지** 보이게 하는 표시일 뿐,
 * 판정에는 쓰지 않는다.
 */
export function relatedCards(input: GateInput, hits: readonly GateHit[]): { card_no: number; rules: GateRuleId[] }[] {
  const out = new Map<number, Set<GateRuleId>>();
  const add = (n: number, r: GateRuleId) => (out.get(n) ?? out.set(n, new Set()).get(n)!).add(r);
  const cards = input.cards.filter((c) => c.kind !== 'cover');
  for (const h of hits) {
    if (h.card_no !== null) { add(h.card_no, h.rule); continue; }
    const topic = RULE_TOPIC[h.rule as AdoptedRuleId];
    if (!topic) continue;
    for (const c of cards) {
      const text = [c.title, ...c.body].join('\n');
      if (h.rule === 'tool_failed') {
        // 성공하지 못한 도구의 축을 말하면서 「확인 못 함」이라고 적은 카드
        const axis = input.signals.missing_tools.some((t) => TOOL_WORDS[t].test(text));
        if (axis && topic.words.test(text)) add(c.card_no, h.rule);
        continue;
      }
      const cites = c.sources.some((src) => src.startsWith(topic.tool) && (!topic.field || topic.field.test(src)));
      if (cites || topic.words.test(text)) add(c.card_no, h.rule);
    }
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([card_no, rules]) => ({ card_no, rules: [...rules] }));
}

export function ruleById(id: GateRuleId): GateRule | undefined {
  return ALL_RULES.find((r) => r.id === id);
}

// ─────────────────────────────────────────────────────────────
// 발행 상태 전이
// ─────────────────────────────────────────────────────────────

/** 다시 판정은 두 번까지. 그 뒤에는 승인·수정·반려 중에서 고른다. */
export const MAX_RETRY = 2;

export type PublishStatus =
  | 'pending_review'   // 기준에 걸려 사람의 답을 기다린다
  | 'retrying'         // 사람이 지시를 주고 다시 만들게 했다
  | 'approved'         // 보내도 된다 (자동 통과 또는 사람 승인)
  | 'rejected'         // 사람이 막았다. 끝
  | 'sending'          // 보내는 중. 이 사이에 다시 보내지 않는다
  | 'published'        // 나갔다. 끝 — 슬랙 웹훅 메시지는 지울 수 없다
  | 'send_failed';     // 보내다 실패했다. 다시 보낼 수 있다

/** 사람이 고친 카드. remove 면 그 카드를 보내지 않는다 (원본 카드 파일은 그대로 둔다). */
export type CardEdit = { card_no: number; title?: string; body?: string[]; remove?: boolean };

export type DecisionInput =
  | { action: 'approve'; version: number }
  | { action: 'edit'; version: number; edits: CardEdit[] }
  | { action: 'reject'; version: number; reason: string }
  | { action: 'retry'; version: number; instruction: string };

export type DecisionRecord = {
  at: string;
  action: DecisionInput['action'];
  reason?: string;
  instruction?: string;
  edits?: CardEdit[];
};

export type PublishState = {
  /** 제출마다 하나씩 오른다. 화면이 보던 버전과 다르면 거절한다 (stale_version). */
  version: number;
  /** 게이트가 사람에게 보냈는가, 그냥 통과시켰는가. 비교표의 「개입」이 이 값이다. */
  route: 'review' | 'auto';
  status: PublishStatus;
  gate: GateResult;
  decisions: DecisionRecord[];
  retries: number;
  /** 사람이 고친 카드. 보낼 때 원본 위에 덮는다. */
  edits: CardEdit[];
  created_at: string;
  updated_at: string;
  sent?: { at: string; dry_run: boolean; channel: 'slack' };
  error?: string;
};

export type TransitionError =
  | 'stale_version' | 'invalid_transition' | 'reason_required'
  | 'instruction_required' | 'edits_required' | 'retry_limit';

export type Transition =
  | { ok: true; state: PublishState }
  | { ok: false; error: TransitionError; message: string };

function next(s: PublishState, patch: Partial<PublishState>, now: string): PublishState {
  return { ...s, ...patch, version: s.version + 1, updated_at: now };
}

function fail(error: TransitionError, message: string): Transition {
  return { ok: false, error, message };
}

/** 게이트 판정으로 첫 상태를 만든다. 걸리지 않았으면 곧바로 보낼 수 있는 상태다. */
export function initialPublishState(gate: GateResult, now: string): PublishState {
  return {
    version: 1,
    route: gate.stop ? 'review' : 'auto',
    status: gate.stop ? 'pending_review' : 'approved',
    gate,
    decisions: [],
    retries: 0,
    edits: [],
    created_at: now,
    updated_at: now,
  };
}

/** 사람의 답을 적용한다. 대기 중인 건에만 답할 수 있다. */
export function applyDecision(s: PublishState, d: DecisionInput, now: string): Transition {
  if (d.version !== s.version) {
    return fail('stale_version', `화면이 본 버전(${d.version})과 지금 버전(${s.version})이 다르다. 새로 읽고 다시 답한다`);
  }
  if (s.status !== 'pending_review') {
    return fail('invalid_transition', `지금 상태(${s.status})에서는 답을 받지 않는다`);
  }
  const at = now;
  switch (d.action) {
    case 'approve':
      return { ok: true, state: next(s, { status: 'approved', decisions: [...s.decisions, { at, action: 'approve' }] }, now) };
    case 'edit': {
      if (!d.edits.length) return fail('edits_required', '고친 카드가 없다. 그대로 보내려면 승인을 누른다');
      return { ok: true, state: next(s, {
        status: 'approved',
        edits: mergeEdits(s.edits, d.edits),
        decisions: [...s.decisions, { at, action: 'edit', edits: d.edits }],
      }, now) };
    }
    case 'reject':
      // 사유가 있어야 나중에 왜 막았는지 추적하고, 기준을 고칠 재료가 된다.
      if (!d.reason.trim()) return fail('reason_required', '반려 사유를 적는다');
      return { ok: true, state: next(s, { status: 'rejected', decisions: [...s.decisions, { at, action: 'reject', reason: d.reason.trim() }] }, now) };
    case 'retry':
      if (!d.instruction.trim()) return fail('instruction_required', '무엇을 다시 할지 지시를 적는다');
      if (s.retries >= MAX_RETRY) {
        return fail('retry_limit', `다시 판정은 ${MAX_RETRY}번까지다. 승인·수정·반려 중에서 고른다`);
      }
      return { ok: true, state: next(s, {
        status: 'retrying',
        retries: s.retries + 1,
        decisions: [...s.decisions, { at, action: 'retry', instruction: d.instruction.trim() }],
      }, now) };
  }
}

/**
 * 카드가 바뀐 뒤 다시 판정한다 — 다시 판정 지시로 새로 만들었거나, 대기 중에 카드를 고쳤을 때.
 * 이미 사람이 들여다본 건이므로 이번에는 기준에 걸리지 않아도 **다시 사람에게 보인다.**
 * 다시 만든 경우에는 카드가 새것이라 이전에 고친 내용(edits)을 버린다.
 */
export function regate(s: PublishState, gate: GateResult, now: string): Transition {
  if (s.status !== 'retrying' && s.status !== 'pending_review') {
    return fail('invalid_transition', `지금 상태(${s.status})는 다시 판정하지 않는다`);
  }
  return { ok: true, state: next(s, { status: 'pending_review', gate, ...(s.status === 'retrying' ? { edits: [] } : {}) }, now) };
}

/** 보내기 시작. 보내는 중이거나 이미 나간 건은 다시 보내지 않는다. */
export function beginSend(s: PublishState, now: string): Transition {
  if (s.status !== 'approved' && s.status !== 'send_failed') {
    return fail('invalid_transition', `지금 상태(${s.status})에서는 보내지 않는다`);
  }
  const { error: _drop, ...rest } = s;
  return { ok: true, state: next(rest as PublishState, { status: 'sending' }, now) };
}

export function finishSend(
  s: PublishState,
  result: { ok: true; dry_run: boolean } | { ok: false; error: string },
  now: string,
): Transition {
  if (s.status !== 'sending') return fail('invalid_transition', `지금 상태(${s.status})는 보내는 중이 아니다`);
  return result.ok
    ? { ok: true, state: next(s, { status: 'published', sent: { at: now, dry_run: result.dry_run, channel: 'slack' } }, now) }
    : { ok: true, state: next(s, { status: 'send_failed', error: result.error }, now) };
}

function mergeEdits(prev: CardEdit[], add: CardEdit[]): CardEdit[] {
  const byNo = new Map(prev.map((e) => [e.card_no, e]));
  for (const e of add) byNo.set(e.card_no, { ...byNo.get(e.card_no), ...e });
  return [...byNo.values()].sort((a, b) => a.card_no - b.card_no);
}

/**
 * 사람이 고친 제목·본문을 원본 카드 위에 덮고, 지운 카드는 뺀다. 원본 파일은 바꾸지 않는다.
 * 에이전트 도구에는 카드를 지우는 기능이 없다 — 지우는 것은 사람이 발행 직전에 한다.
 */
export function applyEdits(cards: BriefingCard[], edits: CardEdit[]): BriefingCard[] {
  const byNo = new Map(edits.map((e) => [e.card_no, e]));
  return cards.filter((c) => !byNo.get(c.card_no)?.remove).map((c) => {
    const e = byNo.get(c.card_no);
    if (!e) return c;
    return { ...c, ...(e.title !== undefined ? { title: e.title } : {}), ...(e.body !== undefined ? { body: e.body } : {}) };
  });
}

// ─────────────────────────────────────────────────────────────
// 슬랙 메시지 (Block Kit)
// ─────────────────────────────────────────────────────────────

/** 슬랙 한도. 넘으면 슬랙이 메시지 전체를 거절한다 — 자르는 쪽이 낫다. */
export const SLACK_LIMITS = { blocks: 50, sectionText: 3000, headerText: 150, contextText: 2000 } as const;

const MARK = { bad: '🔴', warn: '🟡', fyi: '🔵' } as const;

export type SlackMessage = { text: string; blocks: Record<string, unknown>[] };

/** 슬랙 mrkdwn 에서 &, <, > 는 제어 문자다. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cut(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export function buildSlackMessage(
  cards: BriefingCard[],
  meta: { heading: string; footer?: string },
): SlackMessage {
  const body = [...cards].sort((a, b) => a.card_no - b.card_no).filter((c) => c.kind !== 'cover');
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: cut(oneLine(meta.heading), SLACK_LIMITS.headerText), emoji: true } },
  ];
  // 카드 한 장 = section + context 두 블록. 머리·꼬리 자리를 남기고 넣을 수 있는 만큼만 넣는다.
  const room = Math.floor((SLACK_LIMITS.blocks - 3) / 2);
  const shown = body.slice(0, room);
  for (const c of shown) {
    const mark = isFixNow(c) ? MARK.bad : (c.category ? c.category === 'watch' : c.accent === 'warn') ? MARK.warn : MARK.fyi;
    const text = `${mark} *${esc(oneLine(c.title))}*\n${c.body.map(esc).join('\n')}`;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: cut(text, SLACK_LIMITS.sectionText) } });
    if (c.sources.length) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: cut(`근거 · ${c.sources.map(esc).join(' / ')}`, SLACK_LIMITS.contextText) }] });
    }
  }
  if (body.length > shown.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `…외 ${body.length - shown.length}장` } });
  }
  if (meta.footer) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: cut(esc(meta.footer), SLACK_LIMITS.contextText) }] });
  }
  // text 는 알림 미리보기와 블록을 못 그리는 곳에서 쓴다.
  const fix = body.filter(isFixNow).length;
  return { text: `${oneLine(meta.heading)} - 카드 ${body.length}장${fix ? ` · 손봐야 할 것 ${fix}` : ''}`, blocks };
}
