import 'server-only';
/**
 * 발행 게이트의 파일·네트워크 쪽 (DECISIONS.md D37~D39). 판정과 상태 전이는
 * already-got-it-ops-agent/publish 의 순수 함수가 하고, 여기서는 읽고 쓰고 보내기만 한다.
 *
 * 대기 건은 `runs/{id}/publish.json` 에 둔다. 에이전트 실행이 **끝난 뒤** 생기는 대기라
 * 메모리에서 기다리는 콜백이 없다 — 서버를 다시 켜도 그대로 이어서 처리한다.
 * (질문·승인 대기가 재시작하면 interrupted 가 되는 것과 다른 점이다.)
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluateGate, signalsFromToolcalls, relatedCards, initialPublishState, regate, beginSend, finishSend, applyEdits, applyDecision,
  buildSlackMessage, ruleById, isFixNow, MAX_RETRY,
  type BriefingCard, type DecisionInput, type OpsSignals, type PublishState, type ToolcallRecord, type Transition,
  type TransitionError,
} from 'already-got-it-ops-agent/publish';
import { readEnvLocal } from 'already-got-it-ops-agent/env';
import { PROJECT_ROOT, RUNS_DIR } from './paths';
import * as store from './store';
import { readCards } from './derive';
import type { CardView } from './types';

export type PublishError =
  | TransitionError | 'run_not_found' | 'run_not_done' | 'no_cards' | 'no_publish'
  | 'no_session_to_resume' | 'run_is_live' | 'all_cards_removed';

export type PublishResult =
  | { ok: true; state: PublishState }
  | { ok: false; error: PublishError; message: string };

function publishPath(runId: string): string {
  return join(RUNS_DIR, runId, 'publish.json');
}

export function readPublish(runId: string): PublishState | null {
  if (!store.isValidRunId(runId)) return null;
  const p = publishPath(runId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PublishState;
  } catch {
    return null;
  }
}

/** 쓰다가 죽어도 반쯤 쓴 파일이 남지 않게 임시 파일에 쓴 뒤 바꿔 끼운다. */
function writePublish(runId: string, s: PublishState): void {
  const p = publishPath(runId);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, p);
}

/**
 * **파일을 매번 다시 읽는다** (mode.ts 와 같은 이유, D29).
 * 기본은 보내지 않음이다 — 켜 두는 쪽이 사고가 나도 되돌릴 수 없기 때문이다.
 */
export function publishDryRun(): boolean {
  const raw = (readEnvLocal(PROJECT_ROOT, 'PUBLISH_DRY_RUN') ?? process.env.PUBLISH_DRY_RUN ?? '').trim();
  return raw !== '0';
}

function webhookUrl(): string {
  return (readEnvLocal(PROJECT_ROOT, 'SLACK_WEBHOOK_URL') ?? process.env.SLACK_WEBHOOK_URL ?? '').trim();
}

/** 화면용 카드를 게이트 입력으로 돌린다. severity 는 derive.ts 가 분류 칸(category, 없으면 색)에서 만든 값이다. */
function toBriefing(c: CardView): BriefingCard {
  const accent = c.severity === 'FIX_NOW' ? 'bad' : c.severity === 'WATCH' ? 'warn' : 'accent';
  return {
    card_no: c.card_no,
    kind: c.kind,
    title: c.title,
    body: c.body,
    sources: c.sources,
    accent,
  };
}

export function briefingCards(runId: string): BriefingCard[] {
  return readCards(runId).map(toBriefing);
}

/**
 * 도구 기록(MCP 서버가 쓰는 runs/{id}/toolcalls.jsonl)에서 운영 신호를 뽑는다 (D41).
 * 파일이 없거나 한 줄이 깨졌으면 그 부분은 모르는 값(null)으로 둔다 — 0 으로 두지 않는다.
 */
export function briefingSignals(runId: string): OpsSignals {
  const p = join(RUNS_DIR, runId, 'toolcalls.jsonl');
  if (!existsSync(p)) return signalsFromToolcalls([]);
  const records: ToolcallRecord[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as ToolcallRecord); } catch { /* 깨진 줄은 건너뛴다 */ }
  }
  return signalsFromToolcalls(records);
}

function fromTransition(t: Transition): PublishResult {
  return t.ok ? t : { ok: false, error: t.error, message: t.message };
}

function hitSummary(s: PublishState): string {
  return s.gate.hits.map((h) => `${h.card_no === null ? '' : `${h.card_no}번 · `}${ruleById(h.rule)?.label ?? h.rule} - ${h.detail}`).join('\n');
}

/**
 * 끝난 실행을 판정한다. 걸리면 대기로 두고, 안 걸리면 곧바로 보낸다.
 *
 * - publish.json 이 이미 있으면 **새로 만들지 않는다** (같은 실행을 두 번 보내지 않게).
 * - regate: 대기 중이거나 다시 판정 중인 건을 지금 카드로 다시 판정한다. 그 밖의 상태는 거절한다.
 */
export async function gateRun(runId: string, opts: { regate?: boolean } = {}): Promise<PublishResult> {
  const run = store.readState(runId);
  if (!run) return { ok: false, error: 'run_not_found', message: '실행이 없다' };
  if (run.status !== 'done') {
    return { ok: false, error: 'run_not_done', message: `끝난 실행만 발행한다 (지금 ${run.status})` };
  }
  const cards = briefingCards(runId);
  if (!cards.some((c) => c.kind !== 'cover')) {
    return { ok: false, error: 'no_cards', message: '보낼 카드가 없다' };
  }

  const now = new Date().toISOString();
  const gate = evaluateGate({ cards, signals: briefingSignals(runId) });
  const existing = readPublish(runId);

  if (existing) {
    if (!opts.regate) return { ok: true, state: existing };
    const t = regate(existing, gate, now);
    if (!t.ok) return fromTransition(t);
    writePublish(runId, t.state);
    store.appendTrace(runId, {
      kind: 'publish',
      label: `발행 게이트 - 다시 판정 (${t.state.gate.hits.length ? '기준에 걸림' : '기준 통과'}, 사람 확인 대기)`,
      ...(t.state.gate.hits.length ? { detail: hitSummary(t.state) } : {}),
    });
    return { ok: true, state: t.state };
  }

  const first = initialPublishState(gate, now);
  writePublish(runId, first);
  if (first.route === 'review') {
    store.appendTrace(runId, {
      kind: 'publish',
      label: `발행 대기 - 기준 ${new Set(gate.hits.map((h) => h.rule)).size}개에 걸림`,
      detail: hitSummary(first),
    });
    return { ok: true, state: first };
  }
  store.appendTrace(runId, { kind: 'publish', label: '발행 게이트 - 기준 통과, 자동 발행' });
  return sendSlack(runId);
}

/**
 * 보낸다. 상태를 먼저 sending 으로 써 두고 보내므로, 그 사이에 한 번 더 불러도
 * beginSend 가 거절한다. 이미 나간 건(published)도 거절한다 — 웹훅 메시지는 지울 수 없다.
 */
export async function sendSlack(runId: string): Promise<PublishResult> {
  const s = readPublish(runId);
  if (!s) return { ok: false, error: 'no_publish', message: '발행 기록이 없다. 먼저 판정한다' };
  const started = beginSend(s, new Date().toISOString());
  if (!started.ok) return fromTransition(started);
  writePublish(runId, started.state);

  const run = store.readState(runId);
  const period = run?.period ? `${run.period.since.slice(0, 10)} ~ ${run.period.until.slice(0, 10)}` : (run?.created_at ?? '').slice(0, 10);
  const message = buildSlackMessage(applyEdits(briefingCards(runId), started.state.edits), {
    heading: `「이미 있어」 주간 운영 브리핑 · ${period}`,
    footer: `run ${runId} · ${started.state.route === 'auto' ? '기준 통과, 자동 발행' : '사람이 확인하고 발행'}`,
  });

  const dry = publishDryRun();
  let result: { ok: true; dry_run: boolean } | { ok: false; error: string };
  if (dry) {
    // 보내지 않고, 보냈을 내용만 남긴다.
    writeFileSync(join(RUNS_DIR, runId, 'slack-dryrun.json'),
      JSON.stringify({ at: new Date().toISOString(), payload: message }, null, 2));
    result = { ok: true, dry_run: true };
  } else {
    const url = webhookUrl();
    if (!url) {
      result = { ok: false, error: 'SLACK_WEBHOOK_URL 이 없다. .env.local 에 넣거나 PUBLISH_DRY_RUN=1 로 둔다' };
    } else {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(15_000),
        });
        // 성공 응답은 200 과 본문 "ok" 다. 실패는 400/403/404 와 짧은 코드 (예: invalid_blocks).
        result = res.ok ? { ok: true, dry_run: false } : { ok: false, error: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}` };
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  const done = finishSend(started.state, result, new Date().toISOString());
  if (!done.ok) return fromTransition(done);
  writePublish(runId, done.state);
  store.appendTrace(runId, result.ok
    ? { kind: 'publish', label: result.dry_run ? '슬랙 발행 - DRY_RUN (보내지 않고 slack-dryrun.json 에 남김)' : '슬랙 발행 - 보냄' }
    : { kind: 'error', label: '슬랙 발행 실패', detail: result.error, isError: true });
  return { ok: true, state: done.state };
}

/**
 * 실행이 끝나면 runner 가 부른다. 실패해도 실행 결과는 그대로 둔다.
 *
 * - 처음 끝난 실행: 판정한다 (걸리면 대기, 안 걸리면 발행)
 * - 「다시 판정」으로 다시 돈 실행: 새 카드·새 도구 기록으로 다시 판정해 **사람에게 다시 보인다**
 * - 다시 판정하러 돌렸는데 done 이 아니면(멈춤·실패): 이전 판정 그대로 대기로 되돌리고 이유를 남긴다.
 *   그러지 않으면 retrying 에 영원히 멈춰 아무도 답할 수 없다.
 */
export function afterRun(runId: string, status: string): void {
  const existing = readPublish(runId);
  const retrying = existing?.status === 'retrying';
  if (status !== 'done') {
    if (!retrying || !existing) return;
    const t = regate(existing, existing.gate, new Date().toISOString());
    if (t.ok) {
      writePublish(runId, { ...t.state, error: `다시 판정하러 돌린 실행이 ${status} 로 끝났다. 카드는 이전 그대로다` });
      store.appendTrace(runId, { kind: 'error', label: `다시 판정 실패 - 실행이 ${status}`, isError: true });
    }
    return;
  }
  void gateRun(runId, { regate: retrying }).catch((err: unknown) => {
    store.appendTrace(runId, {
      kind: 'error', label: '발행 게이트 실패',
      detail: err instanceof Error ? err.message : String(err), isError: true,
    });
  });
}

/**
 * 다시 판정하러 돌던 실행이 서버 재시작 등으로 끊겼으면 afterRun 이 불리지 않아 retrying 에 갇힌다.
 * 읽을 때마다 확인해 풀어 준다 — 실행이 done 으로 끝나 있었으면 다시 판정하고, 아니면 이전 판정 그대로 대기로 되돌린다.
 */
export async function settleOrphanRetry(runId: string): Promise<void> {
  const p = readPublish(runId);
  if (p?.status !== 'retrying') return;
  const run = store.readState(runId);
  if (!run || run.live) return;   // 아직 돌고 있다 (질문 대기 포함)
  if (run.status === 'done') { await gateRun(runId, { regate: true }); return; }
  const t = regate(p, p.gate, new Date().toISOString());
  if (!t.ok) return;
  writePublish(runId, { ...t.state, error: `다시 판정하러 돌린 실행이 끝나지 못했다 (${run.status}, 서버 재시작 등). 카드는 이전 그대로다` });
  store.appendTrace(runId, { kind: 'error', label: `다시 판정 중단 - 실행이 ${run.status}`, isError: true });
}

/** 다시 판정 때 에이전트에게 넘길 지시. 지시한 카드만 고치고, 굽거나 이슈를 만들지 않게 묶는다. */
export function retryPrompt(instruction: string): string {
  return [
    '사람이 이 브리핑을 슬랙에 내보내기 전에 검토하고, 다시 만들라고 했다.',
    `지시: 「${instruction}」`,
    '지시에 해당하는 카드만 같은 card_no 로 compose_card 를 다시 불러 고친다. 다른 카드는 건드리지 않는다.',
    '고치는 데 새 값이 필요하면 도구를 다시 조회해도 된다. export_cardnews 와 create_github_issue 는 부르지 않는다.',
    '카드를 지우라는 지시는 도구로 할 수 없다 (compose_card 는 덮어쓰기만 한다). 그 카드는 건드리지 말고, 묻지도 말고,',
    '「승인 화면의 edit & approve 에서 remove 로 지운다」고 한 줄로 알린 뒤 끝낸다.',
    '끝나면 무엇을 고쳤는지 한두 줄로 적는다.',
  ].join('\n');
}

/**
 * 사람의 답을 적용한다. 승인·수정 후 승인이면 곧바로 보낸다.
 * 다시 판정은 상태만 retrying 으로 바꾼다 — 에이전트를 다시 돌리는 일은 API 가 한다
 * (runner 를 여기서 부르면 runner → publish → runner 로 순환한다).
 */
export async function decide(runId: string, d: DecisionInput): Promise<PublishResult> {
  const run = store.readState(runId);
  if (!run) return { ok: false, error: 'run_not_found', message: '실행이 없다' };
  const s = readPublish(runId);
  if (!s) return { ok: false, error: 'no_publish', message: '발행 기록이 없다. 먼저 판정한다' };
  if (d.action === 'retry') {
    if (run.live) return { ok: false, error: 'run_is_live', message: '이 실행은 지금 돌고 있다' };
    if (!run.session_id) {
      return { ok: false, error: 'no_session_to_resume',
        message: '이어서 고칠 에이전트 세션이 없다 (세션 ID 가 없다). 수정 후 승인이나 반려를 고른다' };
    }
  }
  if (d.action === 'edit') {
    // 보낼 카드가 하나도 안 남으면 보낼 것이 없다 — 그럴 거면 반려다.
    const after = applyEdits(briefingCards(runId), [...s.edits.filter((e) => !d.edits.some((x) => x.card_no === e.card_no)), ...d.edits]);
    if (!after.some((c) => c.kind !== 'cover')) {
      return { ok: false, error: 'all_cards_removed', message: '카드를 모두 지우면 보낼 것이 없다. 보내지 않으려면 반려한다' };
    }
  }
  const t = applyDecision(s, d, new Date().toISOString());
  if (!t.ok) return fromTransition(t);
  writePublish(runId, t.state);
  const removed = d.action === 'edit' ? d.edits.filter((e) => e.remove).map((e) => e.card_no) : [];
  const label = {
    approve: '발행 승인 - 사람이 확인하고 그대로 보낸다',
    edit: `발행 승인 - 카드 ${d.action === 'edit' ? d.edits.map((e) => e.card_no).join(', ') : ''}번을 고쳐서 보낸다${removed.length ? ` (${removed.join(', ')}번은 지움)` : ''}`,
    reject: '발행 반려 - 보내지 않는다',
    retry: '다시 판정 - 지시를 주고 에이전트가 카드를 고친다',
  }[d.action];
  store.appendTrace(runId, {
    kind: 'publish', label,
    ...(d.action === 'reject' ? { detail: `사유: ${d.reason}` } : d.action === 'retry' ? { detail: `지시: ${d.instruction}` } : {}),
  });
  if (t.state.status === 'approved') return sendSlack(runId);
  return { ok: true, state: t.state };
}

/** 승인 화면에 필요한 것을 한 번에 준다. 화면이 파일을 따로 읽지 않게. */
export function publishView(runId: string) {
  const state = readPublish(runId);
  if (!state) return null;
  const run = store.readState(runId);
  const original = briefingCards(runId);
  const cards = applyEdits(original, state.edits);
  const body = cards.filter((c) => c.kind !== 'cover');
  const signals = briefingSignals(runId);
  return {
    /** 걸린 기준과 관련된 카드 — [ CARDS ] 에서 강조한다. 판정에는 쓰지 않는 표시다. */
    related: relatedCards({ cards: original, signals }, state.gate.hits),
    publish: {
      ...state,
      gate: {
        ...state.gate,
        hits: state.gate.hits.map((h) => ({ ...h, label: ruleById(h.rule)?.label ?? h.rule, risk: ruleById(h.rule)?.risk ?? '' })),
      },
    },
    signals,
    /** 보낼 카드 (고친 내용이 덮인 것). 원본은 original 에 있다. */
    cards,
    original,
    summary: { cards: body.length, fix_now: body.filter(isFixNow).length, removed: state.edits.filter((e) => e.remove).length },
    dry_run: publishDryRun(),
    retry: {
      max: MAX_RETRY, used: state.retries,
      available: Boolean(run?.session_id),
    },
    run: run ? {
      goal: run.goal, period: run.period ?? null, fixture_id: run.fixture_id, created_at: run.created_at, live: run.live,
      /** 다시 판정하러 돈 에이전트가 사람에게 묻고 있다 — 발행 화면만 보면 retrying 에 멈춘 것처럼 보인다. */
      waiting_question: Boolean(run.live && run.pending_question),
    } : null,
  };
}

export type QueueRow = {
  run_id: string; status: PublishState['status']; route: PublishState['route']; waiting_question: boolean;
  rules: string[]; period: { since: string; until: string } | null; created_at: string; updated_at: string;
};

/** 발행 기록이 있는 실행 전부. 사람의 답을 기다리는 것이 먼저, 그다음 최근 것. */
export async function listQueue(): Promise<QueueRow[]> {
  if (!existsSync(RUNS_DIR)) return [];
  const rows: QueueRow[] = [];
  for (const d of readdirSync(RUNS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    await settleOrphanRetry(d.name);
    const s = readPublish(d.name);
    if (!s) continue;
    const run = store.readState(d.name);
    rows.push({
      run_id: d.name, status: s.status, route: s.route,
      waiting_question: Boolean(run?.live && run.pending_question),
      rules: [...new Set(s.gate.hits.map((h) => ruleById(h.rule)?.label ?? h.rule))],
      period: run?.period ?? null, created_at: s.created_at, updated_at: s.updated_at,
    });
  }
  const waiting = (r: QueueRow) => (r.status === 'pending_review' || r.status === 'retrying' || r.status === 'send_failed' ? 0 : 1);
  return rows.sort((a, b) => waiting(a) - waiting(b) || b.updated_at.localeCompare(a.updated_at));
}
