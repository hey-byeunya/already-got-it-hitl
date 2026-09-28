/**
 * 엔진 호출부. Claude Agent SDK 를 이 파일 하나에서만 부른다.
 *
 * 화면은 이 모듈의 이벤트만 보면 되고 SDK 를 직접 모른다.
 * (수업 4절의 "엔진 호출 부분은 분리해 줘" 를 이렇게 지킨다.)
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config as mcpConfig } from 'already-got-it-ops-mcp/config';
import { createGate, type Decider, type GateEvent } from './gate.js';
import { LimitTracker, limitsFromEnv, stopReasonFromSubtype, type LimitConfig, type StopReason } from './limits.js';
import { ShadowGuard } from './shadowguard.js';
import { createPreToolUseHook, type HookDenial } from './hook.js';
import { promptVariantFromEnv, systemPrompt } from './prompt.js';
import { BLOCKED_BUILTINS, MCP_SERVER_KEY, READ_TOOLS, WRITE_TOOLS, shortName } from './tools.js';
import { UsageAccountant, type UsageSnapshot } from './usage.js';

export type RunStatus = 'done' | 'stopped' | 'failed';

export type EngineEvent =
  | { kind: 'started'; runId: string; limits: LimitConfig }
  | { kind: 'hook_denied'; denial: HookDenial }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_use'; tool: string; input: unknown }
  | { kind: 'tool_result'; tool: string; isError: boolean; preview: string }
  | { kind: 'gate'; event: GateEvent }
  | { kind: 'stopped'; reason: StopReason }
  | { kind: 'finished'; status: RunStatus; subtype?: string; usage: UsageSnapshot; sessionId?: string };

export type EngineResult = {
  status: RunStatus;
  subtype?: string;
  sessionId?: string;
  usage: UsageSnapshot;
  stopReason?: StopReason;
  toolCalls: number;
  elapsedSeconds: number;
  waitingSeconds: number;
  /** SDK 가 남긴 거절 기록. 승인 게이트가 실제로 막았다는 근거다. */
  permissionDenials: unknown[];
  /** PreToolUse 훅이 막은 것 (게이트 ③). */
  hookDenials: HookDenial[];
  finalText: string;
};

export type EngineOptions = {
  runId: string;
  goal: string;
  decider: Decider;
  repo?: string;
  model?: string;
  /** 앞선 실행을 이어갈 때. 저장한 세션 ID 를 넘긴다. */
  resumeSessionId?: string;
  mcpServerCommand?: { command: string; args: string[]; env?: Record<string, string> };
  limits?: LimitConfig;
  onEvent?: (e: EngineEvent) => void;
};

export async function runBriefing(opts: EngineOptions): Promise<EngineResult> {
  const limits = opts.limits ?? limitsFromEnv();
  const repo = opts.repo ?? (mcpConfig.allowedRepos[0] ?? 'hey-byeunya/already-got-it');
  const tracker = new LimitTracker(limits);
  const usage = new UsageAccountant();
  // 게이트를 반드시 지나야 하는 것은 쓰기 도구다. 읽기 도구의 자동 승인은 의도한 설계다.
  const guard = new ShadowGuard(WRITE_TOOLS);
  const emit = (e: EngineEvent) => opts.onEvent?.(e);

  const gate = createGate({
    runId: opts.runId,
    decider: opts.decider,
    limits: tracker,
    approvalTtlSeconds: mcpConfig.approvalTtlSeconds,
    onEvent: (event) => emit({ kind: 'gate', event }),
  });

  guard.arm();
  emit({ kind: 'started', runId: opts.runId, limits });

  let stopReason: StopReason | undefined;
  /** result 메시지의 subtype. 성공 여부는 마지막에 stopReason 과 함께 판정한다. */
  let resultOk: boolean | undefined;
  let subtype: string | undefined;
  let sessionId: string | undefined;
  let finalText = '';
  let permissionDenials: unknown[] = [];
  const hookDenials: HookDenial[] = [];
  let sawResult = false;

  const mcp = opts.mcpServerCommand ?? {
    command: process.execPath,
    args: ['mcp-server/dist/src/index.js'],
  };

  try {
    const stream = query({
      prompt: opts.goal,
      options: {
        systemPrompt: systemPrompt({ runId: opts.runId, repo, variant: promptVariantFromEnv() }),
        model: opts.model,
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),

        // 도구 표면 — 읽기 5개만 자동 승인한다.
        // 쓰기 2개를 여기 넣으면 canUseTool 이 건너뛰어져 게이트가 무력화된다 (D14).
        allowedTools: READ_TOOLS,
        disallowedTools: BLOCKED_BUILTINS,
        // dontAsk 는 canUseTool 을 부르지 않아 질문 대기와 승인이 거부된다. default 를 쓴다.
        permissionMode: 'default',
        canUseTool: gate,

        // SDK 가 검사하는 종료 조건 두 개. 나머지 넷은 내가 검사한다.
        maxTurns: limits.maxTurns,
        maxBudgetUsd: limits.maxBudgetUsd,

        // 승인 게이트 ③ — 모든 단계보다 먼저 돌고, bypassPermissions 에서도 deny 가 유효하다.
        hooks: {
          PreToolUse: [{
            hooks: [createPreToolUseHook((d) => {
              hookDenials.push(d);
              emit({ kind: 'hook_denied', denial: d });
            })],
          }],
        },

        mcpServers: {
          [MCP_SERVER_KEY]: { type: 'stdio', command: mcp.command, args: mcp.args,
            ...(mcp.env ? { env: mcp.env } : {}) },
        },
      },
    });

    // 쓰기 게이트가 가려진 채로 실행이 이어지지 않게, 첫 메시지 전에 한 번 확인한다.
    guard.assertGateIntact();

    for await (const msg of stream as AsyncIterable<Record<string, unknown>>) {
      if (msg.type === 'assistant') {
        usage.observeAssistant(msg);
        const content = (msg.message as { content?: unknown[] } | undefined)?.content ?? [];
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'text' && typeof block.text === 'string') {
            finalText = block.text;
            emit({ kind: 'assistant_text', text: block.text });
          } else if (block.type === 'tool_use') {
            const tool = String(block.name);
            tracker.noteToolCall(tool, block.input);
            emit({ kind: 'tool_use', tool: shortName(tool), input: block.input });
          }
        }

        const hit = tracker.check(usage.freshInputTokens);
        if (hit) {
          stopReason = hit;
          emit({ kind: 'stopped', reason: hit });
          await (stream as { interrupt?: () => Promise<void> }).interrupt?.();
          break;
        }
      } else if (msg.type === 'user') {
        const content = (msg.message as { content?: unknown[] } | undefined)?.content ?? [];
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'tool_result') {
            const text = Array.isArray(block.content)
              ? (block.content as Record<string, unknown>[])
                  .map((c) => (typeof c.text === 'string' ? c.text : '')).join('')
              : String(block.content ?? '');
            emit({ kind: 'tool_result', tool: 'result', isError: block.is_error === true,
              preview: text.slice(0, 400) });
          }
        }
      } else if (msg.type === 'result') {
        sawResult = true;
        usage.observeResult(msg);
        subtype = typeof msg.subtype === 'string' ? msg.subtype : undefined;
        sessionId = typeof msg.session_id === 'string' ? msg.session_id : undefined;
        permissionDenials = Array.isArray(msg.permission_denials) ? msg.permission_denials : [];
        resultOk = subtype === 'success';
        // SDK 가 상한으로 끝낸 것도 우리 검사에 걸린 것과 같은 stopped 다 (failed 가 아니다).
        const sdkStop = stopReason ? undefined : stopReasonFromSubtype(subtype, limits, {
          turns: typeof msg.num_turns === 'number' ? msg.num_turns : undefined,
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
        });
        if (sdkStop) {
          stopReason = sdkStop;
          emit({ kind: 'stopped', reason: sdkStop });
        }
        if (typeof msg.result === 'string' && msg.result) finalText = msg.result;
      } else if (msg.type === 'system' && typeof msg.session_id === 'string') {
        sessionId = msg.session_id;
      }
    }

    // 결과 메시지를 못 받았으면 비용은 **모르는 것**이다. 종료 조건에 걸려 중단한 경우도 마찬가지다.
    // 0 으로 적으면 "비용이 안 들었다"고 거짓 보고하게 된다 — 실제로는 토큰을 이미 썼다.
    // (첫 실제 실행에서 캐시 읽기 58,094 토큰을 쓰고도 $0.0000 으로 보고했다.)
    if (!sawResult) {
      usage.markNoResult(
        stopReason
          ? `종료 조건(${stopReason.limit})으로 중단해 결과 메시지를 받지 못했다`
          : '결과 메시지를 받지 못했다 (연결 또는 프로세스 실패)',
      );
    }
    guard.assertGateIntact();
  } finally {
    guard.disarm();
  }

  // 종료 조건에 걸린 것이 성공보다 우선한다. 상한에 닿아 멈춘 실행을 done 으로 부르지 않는다.
  const status: RunStatus = stopReason ? 'stopped' : resultOk === true ? 'done' : 'failed';

  const snapshot = usage.snapshot();
  emit({ kind: 'finished', status, subtype, usage: snapshot, sessionId });

  return {
    status, subtype, sessionId,
    usage: snapshot,
    stopReason,
    toolCalls: tracker.toolCallCount,
    elapsedSeconds: Math.round(tracker.elapsedSeconds() * 10) / 10,
    waitingSeconds: Math.round(tracker.waitingSeconds * 10) / 10,
    permissionDenials,
    hookDenials,
    finalText,
  };
}
