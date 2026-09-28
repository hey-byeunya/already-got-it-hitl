/**
 * 실행 상태 저장소.
 *
 * 두 겹으로 둔다.
 *   - 디스크 (`runs/{id}/ui-state.json`) : 새로고침·서버 재시작 후에도 남는다
 *   - 메모리                              : 대기 중인 콜백의 resolver. **재시작하면 사라진다**
 *
 * 이 구별이 채점 3번의 핵심이다 (API_SPEC.md 「새로고침과 서버 재시작」).
 * 세션 ID 만 저장한다고 화면 상태와 작업이 복구되지는 않는다 — 그래서 질문·답변·단계·
 * 실행 로그를 전부 디스크에 남기고, 재시작 뒤에는 중단 상태를 보여준 뒤 재개하게 한다.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR } from './paths';
import type { PendingApproval, PendingQuestion, RunState, TraceEvent, RunRow } from './types';
import { readCards, resultLine } from './derive';

/** 이 프로세스가 살아 있는 동안만 유효한 것들. */
type LiveHandles = {
  answerResolver?: (answers: Record<string, string> | null) => void;
  approvalResolver?: (d: { approved: true } | { approved: false; reason: string }) => void;
  abort?: AbortController;
};

const live = new Map<string, LiveHandles>();

function statePath(runId: string): string {
  return join(RUNS_DIR, runId, 'ui-state.json');
}

export function isValidRunId(runId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(runId);
}

export function readState(runId: string): RunState | null {
  if (!isValidRunId(runId)) return null;
  const p = statePath(runId);
  if (!existsSync(p)) return null;
  let s: RunState;
  try {
    s = JSON.parse(readFileSync(p, 'utf8')) as RunState;
  } catch {
    // 깨진 상태 파일은 없는 것으로 본다 — 크래시 대신 재시작 후 재개 경로로 간다.
    // (MCP 쪽 기록은 loudly 실패하지만, 화면 상태는 부분 결과라 복구가 우선이다.)
    return null;
  }
  // live 는 디스크 값이 아니라 **이 프로세스의 사실**이다. 재시작하면 false 가 된다.
  s.live = live.has(runId);
  // 대기 중이라고 저장돼 있는데 이 프로세스가 안 들고 있으면 중단된 것이다.
  if (!s.live && (s.status === 'waiting_for_user' || s.status === 'running' || s.status === 'planning')) {
    s.status = 'interrupted';
  }
  return s;
}

export function writeState(s: RunState): void {
  const dir = join(RUNS_DIR, s.run_id);
  mkdirSync(dir, { recursive: true });
  s.updated_at = new Date().toISOString();
  const { live: _omit, ...persisted } = s;
  writeFileSync(statePath(s.run_id), JSON.stringify({ ...persisted, live: false }, null, 2));
}

export function listRuns(): RunRow[] {
  if (!existsSync(RUNS_DIR)) return [];
  const out: RunRow[] = [];
  for (const name of readdirSync(RUNS_DIR)) {
    const s = readState(name);
    if (!s) continue;
    out.push({
      run_id: s.run_id,
      status: s.status,
      created_at: s.created_at,
      fixture_id: s.fixture_id,
      engine: s.engine ?? 'claude',
      // 사용량을 못 받은 실행은 **모르는 것**이다. 0 으로 적으면 «비용이 안 들었다»가 된다.
      cost: s.usage && s.usage.usage_known ? s.usage.total_cost_usd : null,
      result: resultLine(s, readCards(s.run_id).length),
      ...(s.focus ? { focus: s.focus } : {}),
      ...(s.period ? { period: s.period } : {}),
    });
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function createRun(init: {
  runId: string; fixtureId: string | null; goal: string;
  engine?: 'claude';
  focus?: string; period?: { since: string; until: string };
}): RunState {
  const now = new Date().toISOString();
  const s: RunState = {
    run_id: init.runId,
    fixture_id: init.fixtureId,
    engine: init.engine ?? 'claude',
    status: 'planning',
    created_at: now,
    updated_at: now,
    goal: init.goal,
    trace: [],
    pending_question: null,
    pending_approval: null,
    answered: [],
    decisions: [],
    usage: null,
    charts: [],
    live: true,
    ...(init.focus ? { focus: init.focus } : {}),
    ...(init.period ? { period: init.period } : {}),
  };
  writeState(s);
  return s;
}

export function update(runId: string, fn: (s: RunState) => void): RunState | null {
  const s = readState(runId);
  if (!s) return null;
  fn(s);
  writeState(s);
  return s;
}

export function appendTrace(runId: string, e: Omit<TraceEvent, 'seq' | 'at'>): void {
  update(runId, (s) => {
    s.trace.push({ seq: s.trace.length + 1, at: new Date().toISOString(), ...e });
  });
}

// ── 대기 중인 콜백 ────────────────────────────────────────────

export function markLive(runId: string, handles: LiveHandles): void {
  live.set(runId, { ...(live.get(runId) ?? {}), ...handles });
}

export function clearLive(runId: string): void {
  live.delete(runId);
}

/** 질문을 걸어 두고 답이 올 때까지 기다린다. */
export function parkQuestion(runId: string, q: PendingQuestion): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    markLive(runId, { answerResolver: resolve });
    update(runId, (s) => { s.status = 'waiting_for_user'; s.pending_question = q; });
  });
}

/** 답을 받아 대기를 푼다. 지난 버전이면 거절한다. */
export function submitAnswer(runId: string, questionId: string, version: number, answers: Record<string, string>):
  { ok: true } | { ok: false; error: string; detail?: unknown } {
  const s = readState(runId);
  if (!s) return { ok: false, error: 'run_not_found' };
  if (!s.pending_question) {
    // 이미 답했거나 대기 상태가 아니다. 두 번 눌러도 작업이 두 번 돌지 않는다.
    const already = s.answered.find((a) => a.question_id === questionId);
    if (already) return { ok: false, error: 'already_answered', detail: already };
    return { ok: false, error: 'not_waiting' };
  }
  if (s.pending_question.question_id !== questionId) {
    return { ok: false, error: 'stale_question',
      detail: { current: s.pending_question.question_id, submitted: questionId } };
  }
  if (s.pending_question.version !== version) {
    return { ok: false, error: 'stale_version',
      detail: { current: s.pending_question.version, submitted: version } };
  }

  const handles = live.get(runId);
  if (!handles?.answerResolver) {
    // 서버가 재시작돼 기다리던 콜백이 사라졌다. 상태만 고쳐도 작업은 이어지지 않는다.
    return { ok: false, error: 'no_live_callback' };
  }

  // 무엇을 물었는지도 남긴다 — 기록만 보고도 어떤 결정이었는지 읽히게 ([ DECIDED BY HUMAN ]).
  const headers = s.pending_question.questions.map((q) => q.header).filter(Boolean);
  update(runId, (s2) => {
    s2.answered.push({ question_id: questionId, version, answers, ...(headers.length ? { headers } : {}) });
    s2.pending_question = null;
    s2.status = 'running';
  });
  const r = handles.answerResolver;
  delete handles.answerResolver;
  r(answers);
  return { ok: true };
}

/** 승인 요청을 걸어 두고 결정이 올 때까지 기다린다. */
export function parkApproval(runId: string, a: PendingApproval):
  Promise<{ approved: true } | { approved: false; reason: string }> {
  return new Promise((resolve) => {
    markLive(runId, { approvalResolver: resolve });
    update(runId, (s) => { s.status = 'waiting_for_user'; s.pending_approval = a; });
  });
}

export function submitApproval(runId: string, approvalId: string, version: number, approved: boolean, reason?: string):
  { ok: true } | { ok: false; error: string; detail?: unknown } {
  const s = readState(runId);
  if (!s) return { ok: false, error: 'run_not_found' };
  if (!s.pending_approval) {
    const already = s.decisions.find((d) => d.approval_id === approvalId);
    if (already) return { ok: false, error: 'already_decided', detail: already };
    return { ok: false, error: 'not_waiting' };
  }
  if (s.pending_approval.approval_id !== approvalId) {
    return { ok: false, error: 'stale_approval',
      detail: { current: s.pending_approval.approval_id, submitted: approvalId } };
  }
  if (s.pending_approval.version !== version) {
    return { ok: false, error: 'stale_version' };
  }

  const handles = live.get(runId);
  if (!handles?.approvalResolver) return { ok: false, error: 'no_live_callback' };

  const tool = s.pending_approval.tool;
  // 무엇을 승인·거절했는지 나중에도 보이게 제목과 대상을 함께 남긴다 ([ DECIDED BY HUMAN ]).
  const summary = s.pending_approval.summary;
  const title = typeof summary.title === 'string' ? summary.title : undefined;
  const target = typeof summary.repo === 'string' ? summary.repo : undefined;
  update(runId, (s2) => {
    s2.decisions.push({ approval_id: approvalId, tool, approved, reason, at: new Date().toISOString(),
      ...(title ? { title } : {}), ...(target ? { target } : {}) });
    s2.pending_approval = null;
    s2.status = 'running';
  });
  const r = handles.approvalResolver;
  delete handles.approvalResolver;
  r(approved ? { approved: true } : { approved: false, reason: reason ?? '사람이 승인하지 않았다' });
  return { ok: true };
}


/**
 * 실행을 지운다 — 기록·카드·PNG·ZIP 까지 폴더째.
 *
 * **돌고 있는 실행은 지우지 않는다.** 지우는 동안에도 도구가 그 폴더에 쓰고 있어
 * 반만 지워진 상태가 남는다. 끝나고 지우게 한다.
 */
export function removeRun(runId: string): { ok: true } | { ok: false; error: string; message: string } {
  if (!isValidRunId(runId)) return { ok: false, error: 'invalid_run_id', message: 'run_id 형식이 잘못됐다' };
  const dir = join(RUNS_DIR, runId);
  if (!existsSync(dir)) return { ok: false, error: 'run_not_found', message: '그런 실행이 없다' };
  if (live.has(runId)) {
    return { ok: false, error: 'run_is_live', message: '돌고 있는 실행은 지울 수 없다. 끝난 뒤에 지운다' };
  }
  rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}
