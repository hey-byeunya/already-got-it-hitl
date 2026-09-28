/**
 * 승인 게이트 — canUseTool 구현 (DECISIONS.md D14).
 *
 * 이 콜백이 두 가지를 가로챈다.
 *   1. AskUserQuestion  → 질문을 사람에게 넘기고, 답을 updatedInput.answers 로 되돌린다
 *   2. 쓰기 도구        → 사람의 승인을 받고, **승인 시점에** approval_token 을 주입한다
 *
 * 토큰을 updatedInput 으로 주입하는 이유가 중요하다 —
 * **모델은 토큰을 아예 받지 않는다.** 그래서 모델이 토큰을 지어내거나 재사용할 방법이 없다.
 * 게이트를 통과한 호출에만 앱이 토큰을 얹어 준다.
 *
 * 반환값을 null 로 두면 SDK 가 응답 없음으로 처리한다(fail-closed). 항상 결과를 돌려준다.
 */
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { issueToken } from 'already-got-it-ops-mcp/approvals';
import { isWriteTool, shortName } from './tools.js';
import type { LimitTracker } from './limits.js';

export type QuestionSpec = {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect?: boolean;
};

/** 결정하는 쪽. 웹앱은 화면으로 구현한다 (app/lib/runner.ts webDecider). 테스트는 스크립트로 넣는다. */
export interface Decider {
  /** 질문에 답한다. 질문 텍스트 → 고른 라벨. 답하지 않으면 null (거절). */
  answerQuestions(questions: QuestionSpec[]): Promise<Record<string, string> | null>;
  /** 쓰기 도구를 승인한다. */
  approveWrite(tool: string, input: Record<string, unknown>):
    Promise<{ approved: true } | { approved: false; reason: string }>;
}

export type GateEvent =
  | { kind: 'question_waiting'; questions: QuestionSpec[] }
  | { kind: 'question_answered'; answers: Record<string, string> }
  | { kind: 'question_declined' }
  | { kind: 'approval_waiting'; tool: string; input: Record<string, unknown> }
  | { kind: 'approval_granted'; tool: string; target: string }
  | { kind: 'approval_denied'; tool: string; reason: string }
  | { kind: 'auto_allowed'; tool: string };

/**
 * 쓰기 도구의 승인 대상. 토큰이 어느 리소스에 묶이는지 정한다.
 * MCP 서버가 같은 규칙으로 대조하므로 여기서 바뀌면 서버도 함께 고쳐야 한다.
 */
export function approvalTarget(tool: string, input: Record<string, unknown>): string {
  switch (shortName(tool)) {
    case 'create_github_issue':
      return String(input.repo ?? '');
    case 'revert_issue':
      return String(input.issue_number ?? '');
    default:
      return '';
  }
}

export function createGate(opts: {
  runId: string;
  decider: Decider;
  limits: LimitTracker;
  approvalTtlSeconds: number;
  onEvent?: (e: GateEvent) => void;
}): CanUseTool {
  const { runId, decider, limits, approvalTtlSeconds, onEvent } = opts;
  const emit = (e: GateEvent) => onEvent?.(e);

  return async (toolName, input): Promise<PermissionResult> => {
    // ── 1. 질문 대기 ────────────────────────────────────────
    // AskUserQuestion 은 allow 규칙이 있어도 항상 여기로 떨어진다.
    if (toolName === 'AskUserQuestion') {
      const questions = (input.questions ?? []) as QuestionSpec[];
      emit({ kind: 'question_waiting', questions });
      limits.beginWaiting();
      try {
        const answers = await decider.answerQuestions(questions);
        if (!answers) {
          emit({ kind: 'question_declined' });
          return { behavior: 'deny', message: '사용자가 질문에 답하지 않았다. 답 없이 다음 단계로 넘어가지 않는다' };
        }
        emit({ kind: 'question_answered', answers });
        // 답을 updatedInput 으로 되돌리면 대기하던 실행이 이어진다.
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      } finally {
        limits.endWaiting();
      }
    }

    // ── 2. 쓰기 도구 승인 ───────────────────────────────────
    if (isWriteTool(toolName)) {
      const target = approvalTarget(toolName, input);
      if (!target) {
        return { behavior: 'deny',
          message: `${shortName(toolName)} 의 승인 대상을 입력에서 찾을 수 없다. repo 또는 issue_number 가 필요하다` };
      }

      emit({ kind: 'approval_waiting', tool: toolName, input });
      limits.beginWaiting();
      try {
        const decision = await decider.approveWrite(toolName, input);
        if (!decision.approved) {
          emit({ kind: 'approval_denied', tool: toolName, reason: decision.reason });
          return { behavior: 'deny', message: `사람이 승인하지 않았다: ${decision.reason}` };
        }

        // 승인 시점에만 토큰을 만든다. 모델은 이 값을 보지 못한다.
        const token = issueToken(runId, shortName(toolName), target, approvalTtlSeconds);
        emit({ kind: 'approval_granted', tool: toolName, target });
        return { behavior: 'allow', updatedInput: { ...input, approval_token: token.token } };
      } finally {
        limits.endWaiting();
      }
    }

    // ── 3. 그 밖 ────────────────────────────────────────────
    // 읽기 도구는 allowedTools 로 자동 승인되므로 보통 여기 오지 않는다.
    // 여기 왔다는 것은 예상하지 못한 도구라는 뜻이라, 열어 주지 않는다.
    emit({ kind: 'auto_allowed', tool: toolName });
    return { behavior: 'deny',
      message: `허용 목록에 없는 도구다: ${toolName}. 이 앱은 도메인 도구 9개만 쓴다` };
  };
}
