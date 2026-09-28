/**
 * 오류는 예외로 던지지 않고 도구 결과로 모델에게 되돌린다.
 * 작업 전체를 죽이지 않기 위해서다 (TOOLS.md 「오류 규약」).
 *
 * code    : 프로그램용. TOOLS.md 의 오류 코드와 1:1
 * message : 사람과 모델이 읽을 설명
 * extra   : 회복 정보. 무엇이 있었는지, 가장 가까운 유효한 값이 무엇인지
 */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ToolError';
  }

  asResult(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

/** 재시도해도 소용없는 오류. 즉시 중단한다. */
export class FatalToolError extends ToolError {
  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(code, message, extra);
    this.name = 'FatalToolError';
  }
}
