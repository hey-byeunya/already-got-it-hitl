/**
 * 토큰·비용 집계 (DECISIONS.md D15).
 *
 * 문서가 경고한 함정 네 개를 코드로 지킨다.
 *   ① 병렬 도구 호출은 assistant 메시지 id 가 같다 → ID 로 중복 제거
 *   ② per-step output_tokens 는 placeholder → 출력 토큰은 result 메시지에서
 *   ③ usage 는 서브에이전트를 제외 → 전체는 modelUsage 로 ("Prefer modelUsage")
 *   ④ 크래시·예산초과 결과는 비용 필드가 0 이거나 빠질 수 있다
 *      → **0 으로 뭉개지 말고 usage_known: false 로**
 *
 * 사용량을 모르는 것과 0 인 것은 다르다. 0 으로 적으면 비용이 안 들었다고 거짓 보고하게 된다.
 */
export type UsageSnapshot = {
  usage_known: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number;
  /** 화면에 반드시 함께 표시한다. 실제 청구액이 아니다. */
  cost_is_estimate: true;
  /** 집계에서 제외한 이유. usage_known 이 false 일 때 채운다. */
  unknown_reason?: string;
};

export class UsageAccountant {
  /** ① 이미 센 assistant 메시지 id. 병렬 도구 호출은 같은 id 를 공유한다. */
  private seenMessageIds = new Set<string>();
  private inputTokens = 0;
  private cacheRead = 0;
  private cacheCreate = 0;

  private resultOutputTokens = 0;
  private costUsd = 0;
  private known = true;
  private unknownReason: string | undefined;

  /** assistant 메시지에서 입력·캐시 토큰을 누적한다. 출력 토큰은 여기서 세지 않는다(②). */
  observeAssistant(msg: unknown): void {
    const m = msg as {
      parent_tool_use_id?: string | null;
      message?: { id?: string; usage?: Record<string, number> };
    };
    // ③ 서브에이전트 메시지는 건너뛴다. 전체 합계는 modelUsage 에서 읽는다.
    if (m.parent_tool_use_id) return;

    const id = m.message?.id;
    const usage = m.message?.usage;
    if (!id || !usage) return;
    if (this.seenMessageIds.has(id)) return; // ① 중복 제거
    this.seenMessageIds.add(id);

    this.inputTokens += usage.input_tokens ?? 0;
    this.cacheRead += usage.cache_read_input_tokens ?? 0;
    this.cacheCreate += usage.cache_creation_input_tokens ?? 0;
  }

  /** result 메시지에서 출력 토큰과 비용을 읽는다. */
  observeResult(msg: unknown): void {
    const m = msg as {
      subtype?: string;
      total_cost_usd?: number;
      usage?: Record<string, number>;
      modelUsage?: Record<string, { costUSD?: number; outputTokens?: number; inputTokens?: number }>;
    };

    // ③ modelUsage 가 있으면 그쪽이 서브에이전트까지 포함한 전체다.
    const models = m.modelUsage ? Object.values(m.modelUsage) : [];
    const costFromModels = models.reduce((s, u) => s + (u.costUSD ?? 0), 0);
    const outFromModels = models.reduce((s, u) => s + (u.outputTokens ?? 0), 0);

    this.resultOutputTokens = outFromModels || m.usage?.output_tokens || 0;
    this.costUsd = costFromModels || m.total_cost_usd || 0;

    // ④ 비용 필드를 신뢰할 수 없는 경우를 표시한다.
    if (m.subtype === 'error_during_execution') {
      // 크래시 결과는 모든 비용 필드가 0 일 수 있다.
      if (this.costUsd === 0) {
        this.known = false;
        this.unknownReason = '세션이 크래시로 끝나 비용 필드가 비었다 (error_during_execution)';
      }
    } else if (m.subtype === 'error_max_budget_usd') {
      // usage 는 예산을 넘긴 마지막 응답을 빼고 보고한다. cost 쪽이 더 정확하다.
      if (this.costUsd === 0) {
        this.known = false;
        this.unknownReason = '예산 초과로 끝났고 비용 필드를 읽지 못했다 (error_max_budget_usd)';
      }
    }
  }

  /** 결과 메시지를 아예 받지 못한 경우 (연결·프로세스 실패). */
  markNoResult(reason: string): void {
    this.known = false;
    this.unknownReason = reason;
  }

  snapshot(): UsageSnapshot {
    return {
      usage_known: this.known,
      input_tokens: this.inputTokens,
      output_tokens: this.resultOutputTokens,
      cache_read_input_tokens: this.cacheRead,
      cache_creation_input_tokens: this.cacheCreate,
      total_cost_usd: this.costUsd,
      cost_is_estimate: true,
      ...(this.known ? {} : { unknown_reason: this.unknownReason }),
    };
  }

  /**
   * 종료 조건용 — **새로 읽은 입력 토큰**만 센다. 캐시 읽기는 제외한다.
   *
   * 캐시 읽기는 앞선 맥락을 재사용하는 값싼 경로다(입력 정가의 일부). 에이전트 루프에서는
   * 턴이 늘수록 빠르게 쌓여서, 신규 입력과 같은 무게로 세면 정상 실행이 상한에 걸린다.
   * (첫 실제 실행에서 259,455 중 대부분이 캐시 읽기였는데 상한 200,000 에 걸려 중단됐다.)
   *
   * 비용 자체는 maxBudgetUsd 가 가격 가중치로 이미 막는다. 이 상한의 몫은
   * "맥락이 통제 불가로 커지는 것"을 막는 데 있다.
   */
  get freshInputTokens(): number {
    return this.inputTokens + this.cacheCreate;
  }

  /** 참고용 — 캐시 읽기까지 포함한 전체. 화면 표시에만 쓴다. */
  get allInputTokens(): number {
    return this.inputTokens + this.cacheRead + this.cacheCreate;
  }
}
