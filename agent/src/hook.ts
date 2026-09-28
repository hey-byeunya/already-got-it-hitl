/**
 * 승인 게이트 세 번째 겹 — PreToolUse 훅 (DECISIONS.md D14 ③).
 *
 * 이 훅이 다른 두 겹과 다른 점: **모든 단계보다 먼저 실행되고, 훅의 deny 는
 * bypassPermissions 에서도 유효하다.** allowedTools 설정이나 권한 모드로 우회되지 않는다.
 *
 * 그래서 여기서는 "설정이 어떻든 반드시 참이어야 하는 것"만 검사한다. 두 가지다.
 *
 *  ① 도구 표면 — 도메인 도구 9개와 AskUserQuestion 밖의 도구는 부르지 않는다.
 *    disallowedTools 가 잘못 설정되거나 bypassPermissions 가 켜져도 이 검사는 남는다.
 *
 *  ② 토큰의 출처 — **모델은 approval_token 을 절대 스스로 넣지 않는다.**
 *    토큰은 canUseTool 이 사람의 승인을 받은 뒤 updatedInput 으로만 주입한다.
 *    모델이 보낸 입력에 토큰이 들어 있다면 지어냈거나 어디서 베낀 것이므로 거절한다.
 *
 * ②를 두는 이유: ①②(meta·서버 검사)는 "유효한 토큰이면 실행한다"까지만 보장한다.
 * 토큰이 **어디서 왔는지**는 보장하지 않는다. 지금은 모델이 토큰을 알 경로가 없지만,
 * 나중에 입력을 되돌려 주는 도구나 로그를 모델에 먹이는 화면이 생기면 그 경로가 열린다.
 * 불변식을 우연에 맡기지 않고 못 박는다.
 *
 * 훅이 하지 않는 것: "승인 기록이 있는지" 검사. 훅은 canUseTool **보다 먼저** 돌기 때문에
 * 그 시점에는 아직 승인이 없다. 거기서 막으면 사람이 묻기도 전에 모든 쓰기가 차단된다.
 */
import type { HookCallback, HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { READ_TOOLS, WRITE_TOOLS, isWriteTool, shortName } from './tools.js';

/** 이 앱이 부르도록 허용한 이름 전체. 이 밖은 훅이 거절한다. */
export const ALLOWED_TOOL_NAMES = [...READ_TOOLS, ...WRITE_TOOLS, 'AskUserQuestion'];

export type HookDenial = {
  tool: string;
  rule: 'tool_not_allowed' | 'model_supplied_approval_token';
  reason: string;
};

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** 판단하지 않고 넘긴다. 이후 단계(거절 규칙 → 권한 모드 → 허용 규칙 → canUseTool)가 정한다. */
function passThrough(): HookJSONOutput {
  return { continue: true, suppressOutput: true };
}

/** 순수 함수로 판정만 한다. 검사에서 그대로 부를 수 있게 훅과 분리한다. */
export function evaluate(toolName: string, toolInput: unknown): HookDenial | null {
  // ① 도구 표면
  if (!ALLOWED_TOOL_NAMES.includes(toolName)) {
    return {
      tool: toolName,
      rule: 'tool_not_allowed',
      reason: `허용하지 않은 도구다: ${toolName}. 이 앱은 도메인 도구 9개와 AskUserQuestion 만 쓴다.`,
    };
  }

  // ② 토큰의 출처
  if (isWriteTool(toolName)
    && toolInput !== null && typeof toolInput === 'object'
    && 'approval_token' in (toolInput as Record<string, unknown>)) {
    return {
      tool: toolName,
      rule: 'model_supplied_approval_token',
      reason:
        `${shortName(toolName)} 입력에 approval_token 이 들어 있다. 승인 토큰은 사람의 승인을 받은 뒤 `
        + '앱이 주입하는 값이며, 모델이 스스로 넣을 수 없다. 지어낸 값이거나 베낀 값이므로 거절한다.',
    };
  }

  return null;
}

/**
 * 훅을 만든다.
 * @param onDenial 거절을 기록할 곳. 실행 로그와 화면에 남긴다 — 조용히 막지 않는다.
 */
export function createPreToolUseHook(onDenial?: (d: HookDenial) => void): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return passThrough();
    const { tool_name, tool_input } = input as PreToolUseHookInput;

    const denial = evaluate(tool_name, tool_input);
    if (!denial) return passThrough();

    onDenial?.(denial);
    return deny(denial.reason);
  };
}
