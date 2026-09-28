/**
 * 종료 조건 (DECISIONS.md D7).
 *
 * SDK 가 검사하는 것 두 개(maxTurns · maxBudgetUsd)는 옵션으로 넘긴다.
 * 나머지 네 개는 여기서 내가 검사한다.
 *
 * 종료는 **코드가 검사**한다. 모델의 "다 했다" 한 마디에 맡기지 않는다.
 * waiting_for_user 로 보낸 시간은 실행 시간에 넣지 않는다 — 사람을 기다리는 건 정상이다.
 */
export type LimitConfig = {
  maxTurns: number;
  maxBudgetUsd: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxElapsedSeconds: number;
  maxSameToolStreak: number;
};

export const DEFAULT_LIMITS: LimitConfig = {
  maxTurns: 20,
  maxBudgetUsd: 1.0,
  maxToolCalls: 40,
  maxInputTokens: 200_000,
  maxElapsedSeconds: 600,
  maxSameToolStreak: 3,
};

export type StopReason = {
  limit: keyof LimitConfig;
  message: string;
  observed: number;
  allowed: number;
};

/**
 * SDK 가 검사하는 두 상한(maxTurns · maxBudgetUsd)에 닿으면 result 의 subtype 으로만 알 수 있다.
 * 이것을 실패로 부르면 「상한에 닿아 멈춘 실행」이 「고장 난 실행」과 구별되지 않는다 — 우리 검사와 같은 stopped 로 맞춘다.
 */
export function stopReasonFromSubtype(
  subtype: string | undefined, limits: LimitConfig, observed: { turns?: number; costUsd?: number } = {},
): StopReason | undefined {
  if (subtype === 'error_max_turns') {
    return { limit: 'maxTurns', message: '턴 상한에 닿았다 (SDK 가 끝냈다)',
      observed: observed.turns ?? limits.maxTurns, allowed: limits.maxTurns };
  }
  if (subtype === 'error_max_budget_usd') {
    return { limit: 'maxBudgetUsd', message: '예산 상한에 닿았다 (SDK 가 끝냈다)',
      observed: observed.costUsd ?? limits.maxBudgetUsd, allowed: limits.maxBudgetUsd };
  }
  return undefined;
}

export class LimitTracker {
  private toolCalls = 0;
  /** 도구 이름 + 인자를 합친 지문. 인자가 다르면 다른 호출로 본다. */
  private lastCallFingerprint: string | null = null;
  private lastTool: string | null = null;
  private sameToolStreak = 0;
  private startedAt = Date.now();
  /** 사람을 기다린 누적 시간. 실행 시간에서 뺀다. */
  private waitingMs = 0;
  private waitStartedAt: number | null = null;

  constructor(private readonly limits: LimitConfig = DEFAULT_LIMITS) {}

  /**
   * 도구 호출을 센다.
   *
   * 연속 카운터는 **같은 도구를 같은 인자로** 부를 때만 올라간다.
   * 인자가 다르면 진전이 있는 것이다 — 검색어를 바꿔 가며 web_search 를 네 번 부르는 것은
   * 막힌 게 아니라 일하는 중이다. (첫 실제 실행에서 이걸 막아 버렸다.)
   */
  noteToolCall(toolName: string, input?: unknown): void {
    this.toolCalls += 1;
    const fingerprint = `${toolName}::${stableStringify(input)}`;
    if (fingerprint === this.lastCallFingerprint) {
      this.sameToolStreak += 1;
    } else {
      this.lastCallFingerprint = fingerprint;
      this.sameToolStreak = 1;
    }
    this.lastTool = toolName;
  }

  beginWaiting(): void {
    if (this.waitStartedAt === null) this.waitStartedAt = Date.now();
  }

  endWaiting(): void {
    if (this.waitStartedAt !== null) {
      this.waitingMs += Date.now() - this.waitStartedAt;
      this.waitStartedAt = null;
    }
  }

  /** 대기 시간을 제외한 실행 경과 초. */
  elapsedSeconds(): number {
    const pendingWait = this.waitStartedAt !== null ? Date.now() - this.waitStartedAt : 0;
    return (Date.now() - this.startedAt - this.waitingMs - pendingWait) / 1000;
  }

  get toolCallCount(): number { return this.toolCalls; }
  get waitingSeconds(): number { return this.waitingMs / 1000; }

  /** 하나라도 걸리면 이유를 돌려준다. 걸린 게 없으면 null. */
  /** @param freshInputTokens 캐시 읽기를 제외한 누적 신규 입력 토큰 */
  check(freshInputTokens: number): StopReason | null {
    // 경계는 초과(>)다. 상한값 자체는 허용하고 그 다음부터 막는다.
    // "상한까지는 통과해야 한다"는 검사와 짝이다 — `>=` 로 바꾸면 정상 실행이 일찍 끊긴다.
    if (this.toolCalls > this.limits.maxToolCalls) {
      return { limit: 'maxToolCalls', message: '도구 호출 상한에 닿았다',
        observed: this.toolCalls, allowed: this.limits.maxToolCalls };
    }
    if (this.sameToolStreak > this.limits.maxSameToolStreak) {
      return { limit: 'maxSameToolStreak',
        message: `같은 도구(${this.lastTool})를 **같은 인자로** 연속 호출해 진전이 없다고 본다`,
        observed: this.sameToolStreak, allowed: this.limits.maxSameToolStreak };
    }
    if (freshInputTokens > this.limits.maxInputTokens) {
      return { limit: 'maxInputTokens', message: '누적 신규 입력 토큰 상한에 닿았다 (캐시 읽기 제외)',
        observed: freshInputTokens, allowed: this.limits.maxInputTokens };
    }
    const elapsed = this.elapsedSeconds();
    if (elapsed > this.limits.maxElapsedSeconds) {
      return { limit: 'maxElapsedSeconds', message: '실행 시간 상한에 닿았다 (대기 시간 제외)',
        observed: Math.round(elapsed), allowed: this.limits.maxElapsedSeconds };
    }
    return null;
  }
}

/** 환경변수로 상한을 낮춰 실제로 걸어 볼 수 있게 한다 (캡처용). */
export function limitsFromEnv(): LimitConfig {
  const num = (k: string, d: number) => {
    const v = process.env[k];
    if (v === undefined || v === '') return d;
    const n = Number(v);
    // 오타가 NaN 상한으로 들어가면 모든 비교가 false 가 돼 상한이 무력화된다.
    if (!Number.isFinite(n)) {
      console.warn(`[limits] ${k}="${v}" 가 숫자가 아니라 기본값 ${d} 를 쓴다`);
      return d;
    }
    return n;
  };
  return {
    maxTurns: num('OPS_MAX_TURNS', DEFAULT_LIMITS.maxTurns),
    maxBudgetUsd: num('OPS_MAX_BUDGET_USD', DEFAULT_LIMITS.maxBudgetUsd),
    maxToolCalls: num('OPS_MAX_TOOL_CALLS', DEFAULT_LIMITS.maxToolCalls),
    maxInputTokens: num('OPS_MAX_INPUT_TOKENS', DEFAULT_LIMITS.maxInputTokens),
    maxElapsedSeconds: num('OPS_MAX_ELAPSED_SECONDS', DEFAULT_LIMITS.maxElapsedSeconds),
    maxSameToolStreak: num('OPS_MAX_SAME_TOOL_STREAK', DEFAULT_LIMITS.maxSameToolStreak),
  };
}

/** 키 순서가 달라도 같은 지문이 나오게 한다. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`;
}
