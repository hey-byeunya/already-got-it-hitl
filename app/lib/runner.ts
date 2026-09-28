/**
 * 엔진을 백그라운드로 돌리고, Decider 를 화면으로 갈아 끼운다.
 *
 * agent/ 의 engine.ts 는 그대로 쓴다. 바뀌는 것은 "누가 결정하는가" 하나다 —
 * 여기서는 사람이 화면에서 결정한다 (webDecider).
 */
import 'server-only';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runBriefing } from 'already-got-it-ops-agent/engine';
import type { Decider, QuestionSpec } from 'already-got-it-ops-agent/gate';
import { loadEnvLocal } from 'already-got-it-ops-agent/env';
import { liveWritesEnabled, opsMode } from './mode';
import { limitsFromEnv } from 'already-got-it-ops-agent/limits';
import { FIXTURES_DIR, MCP_ENTRY, PROJECT_ROOT, RUNS_DIR } from './paths';
import * as store from './store';
import { afterRun } from './publish';

let envLoaded = false;
/** .env.local 을 읽는다. 파서는 agent/src/env.ts 한 곳에만 있다. */
function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  loadEnvLocal(PROJECT_ROOT);
}

// 모드 판정은 mode.ts 한 곳에 있다. 여기서는 부르는 쪽 편의를 위해 다시 내보낸다.
export { liveWritesEnabled, opsMode };

export type CredentialSource = 'api_key' | 'auth_token' | 'stored_login';

/**
 * 어느 자격증명으로 돌게 될지 알린다.
 *
 * ⚠️ 환경변수 키가 없다고 자격증명이 없다는 뜻은 아니다. SDK 는
 * ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN → **저장된 로그인(구독)** 순으로 찾는다.
 * 그래서 키가 없을 때 실행을 막지 않는다 — 막으면 구독으로 도는 경로를 코드가 닫아 버린다.
 *
 * 어느 쪽인지는 비용이 어느 지갑에서 빠지는지를 결정하므로 화면에 표시한다.
 */

export function credentialSource(): CredentialSource {
  loadEnv();
  if (process.env.ANTHROPIC_API_KEY) return 'api_key';
  if (process.env.ANTHROPIC_AUTH_TOKEN) return 'auth_token';
  return 'stored_login';
}

const short = (v: unknown, n = 2000) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > n ? `${s.slice(0, n)}\n…(${s.length - n}자 줄임)` : s;
};

/** 화면이 결정하는 Decider. 약속을 걸어 두고 사람이 누를 때까지 기다린다. */
function webDecider(runId: string): Decider {
  return {
    async answerQuestions(questions: QuestionSpec[]) {
      const version = (store.readState(runId)?.answered.length ?? 0) + 1;
      return store.parkQuestion(runId, {
        question_id: `q-${version}-${Date.now().toString(36)}`,
        version,
        questions,
      });
    },
    async approveWrite(tool, input) {
      const version = (store.readState(runId)?.decisions.length ?? 0) + 1;
      return store.parkApproval(runId, {
        approval_id: `a-${version}-${Date.now().toString(36)}`,
        version,
        tool,
        summary: input,
      });
    },
  };
}

export type StartOptions = {
  runId: string;
  fixtureId: string | null;
  goal: string;
  resumeSessionId?: string;
};

/** 실행을 백그라운드로 시작한다. 응답은 기다리지 않는다. */
export function start(opts: StartOptions): void {
  loadEnv();
  const { runId, fixtureId, goal, resumeSessionId } = opts;

  const childEnv: Record<string, string> = {
    OPS_MODE: opsMode(),
    OPS_RUNS_DIR: RUNS_DIR,
    OPS_FIXTURES_DIR: FIXTURES_DIR,
    GITHUB_ALLOWED_REPOS: process.env.GITHUB_ALLOWED_REPOS ?? 'hey-byeunya/already-got-it',
    ...(fixtureId ? { OPS_FIXTURE_ID: fixtureId } : {}),
    ...(liveWritesEnabled() ? { OPS_ALLOW_LIVE_WRITES: '1' } : {}),
  };
  // 승인 토큰을 이 프로세스가 쓰고 MCP 서버가 읽는다. 같은 경로를 봐야 한다.
  process.env.OPS_RUNS_DIR = RUNS_DIR;

  store.markLive(runId, {});
  const cred = credentialSource();
  store.update(runId, (s) => { s.status = 'planning'; s.credential_source = cred; });

  void runBriefing({
    runId,
    goal,
    decider: webDecider(runId),
    ...(resumeSessionId ? { resumeSessionId } : {}),
    mcpServerCommand: { command: process.execPath, args: [MCP_ENTRY], env: childEnv },
    limits: limitsFromEnv(),
    onEvent: (e) => {
      switch (e.kind) {
        case 'started':
          store.appendTrace(runId, { kind: e.kind, label: '실행 시작',
            detail: `상한: 반복 ${e.limits.maxTurns} · 도구 ${e.limits.maxToolCalls}`
              + ` · 비용 $${e.limits.maxBudgetUsd} · 시간 ${e.limits.maxElapsedSeconds}s`
              + ` · 같은도구연속 ${e.limits.maxSameToolStreak}` });
          // 상한을 **값으로도** 남긴다. 화면의 예산 게이지가 분모로 쓴다.
          // 위 문자열은 사람이 읽는 용도라 값으로 되꺼낼 수 없다.
          store.update(runId, (s) => { s.status = 'running'; s.limits = e.limits; });
          break;
        case 'assistant_text':
          if (e.text.trim()) {
            store.appendTrace(runId, { kind: e.kind, label: '에이전트', detail: e.text });
          }
          break;
        case 'tool_use':
          store.appendTrace(runId, { kind: e.kind, label: `도구 호출 - ${e.tool}`, detail: short(e.input) });
          break;
        case 'tool_result':
          store.appendTrace(runId, { kind: e.kind,
            label: e.isError ? '도구 결과 - 오류' : '도구 결과', detail: e.preview, isError: e.isError });
          break;
        case 'hook_denied':
          store.appendTrace(runId, {
            kind: 'hook_denied',
            label: `PreToolUse 훅이 막음 (${e.denial.rule}) - ${e.denial.tool}`,
            detail: e.denial.reason
              + '\n\n훅은 모든 단계보다 먼저 돌고, bypassPermissions 에서도 deny 가 유효하다 (게이트 ③).',
            isError: true,
          });
          break;
        case 'gate':
          handleGateEvent(runId, e.event);
          break;
        case 'stopped':
          store.update(runId, (s) => {
            s.status = 'stopped';
            s.stop_reason = e.reason;
            s.trace.push({ seq: s.trace.length + 1, at: new Date().toISOString(), kind: 'stopped',
              label: `종료 조건 - ${e.reason.limit}`,
              detail: `${e.reason.message}\n관측 ${e.reason.observed} / 허용 ${e.reason.allowed}`,
              isError: true });
          });
          break;
        case 'finished':
          store.appendTrace(runId, { kind: e.kind, label: `종료 - ${e.status}${e.subtype ? ` (${e.subtype})` : ''}` });
          break;
      }
    },
  })
    .then((result) => {
      const final = store.update(runId, (s) => {
        // 종료 조건이 걸린 실행을 done 으로 덮지 않는다.
        s.status = s.status === 'stopped' ? 'stopped' : result.status;
        s.usage = result.usage;
        s.session_id = result.sessionId;
        s.final_text = result.finalText;
        s.elapsed_seconds = result.elapsedSeconds;
        if (result.stopReason) s.stop_reason = result.stopReason;
        s.charts = collectCharts(runId);
      });
      // 끝난 실행만 발행 게이트로 간다. 멈춘·실패한 실행은 보내지 않는다 (D37).
      // 다시 판정하러 돌린 실행이면 끝난 모양에 따라 다시 판정하거나 대기로 되돌린다.
      if (final) afterRun(runId, final.status);
    })
    .catch((err: unknown) => {
      store.update(runId, (s) => {
        s.status = 'failed';
        s.trace.push({ seq: s.trace.length + 1, at: new Date().toISOString(), kind: 'error',
          label: '실행 실패', detail: err instanceof Error ? err.message : String(err), isError: true });
      });
    })
    .finally(() => store.clearLive(runId));
}

function handleGateEvent(runId: string, ev: { kind: string } & Record<string, unknown>): void {
  switch (ev.kind) {
    case 'question_waiting':
      store.appendTrace(runId, { kind: ev.kind, label: '질문 대기 - 사람의 답을 기다린다',
        detail: short(ev.questions) });
      break;
    case 'question_answered':
      store.appendTrace(runId, { kind: ev.kind, label: '답변 받음', detail: short(ev.answers) });
      break;
    case 'question_declined':
      store.appendTrace(runId, { kind: ev.kind, label: '답하지 않음 - 다음 단계로 넘어가지 않는다', isError: true });
      break;
    case 'approval_waiting':
      store.appendTrace(runId, { kind: ev.kind, label: `승인 대기 - ${String(ev.tool)}`,
        detail: short(ev.input) });
      break;
    case 'approval_granted':
      store.appendTrace(runId, { kind: ev.kind,
        label: `승인됨 - ${String(ev.tool)} (대상 ${String(ev.target)})`,
        detail: '승인 시점에 1회용 토큰을 주입해 실행한다. 모델은 토큰을 받지 않는다.' });
      break;
    case 'approval_denied':
      store.appendTrace(runId, { kind: ev.kind, label: `거절됨 - ${String(ev.tool)}`,
        detail: String(ev.reason), isError: true });
      break;
  }
}

function collectCharts(runId: string): { card_no: number; svg_path: string }[] {
  try {
    const dir = resolve(RUNS_DIR, runId, 'charts');
    if (!existsSync(dir)) return [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    return readdirSync(dir).filter((f) => f.endsWith('.svg')).sort()
      .map((f) => ({ card_no: Number(f.replace('.svg', '')), svg_path: `charts/${f}` }));
  } catch { return []; }
}
