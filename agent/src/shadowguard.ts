/**
 * 승인 게이트가 가려졌는지 감시한다 (DECISIONS.md D14 자체 검사).
 *
 * allowedTools 의 맨이름 항목이 canUseTool 을 가리면 SDK 가
 * CLAUDE_SDK_CAN_USE_TOOL_SHADOWED 경고를 띄우고, **가려진 도구 이름들을 함께 알려 준다.**
 *
 * ⚠️ 중요 — 경고가 떴다는 사실만으로 실패시키면 안 된다.
 * 이 앱은 읽기 도구 5개를 **의도적으로** allowedTools 에 넣어 자동 승인한다.
 * 매번 물으면 브리핑을 만들 수 없기 때문이다. 그 5개에 대한 경고는 정상이다.
 *
 * 실패로 처리해야 하는 것은 **쓰기 도구가 가려진 경우**뿐이다. 그때는 승인 화면이
 * 뜨지 않은 채 GitHub 에 기록이 남는다.
 *
 * (처음에는 경고만 보고 전부 실패시켰다가, 첫 실제 실행에서 정상 설정이 막혔다.
 *  가드에는 반드시 경계 검사를 짝지어야 한다는 것을 다시 확인한 자리다.)
 */
export class ShadowGuard {
  private shadowedTools: string[] = [];
  private rawMessage: string | null = null;
  private handler: ((w: Error & { code?: string }) => void) | null = null;

  /** @param gatedTools 반드시 게이트를 지나야 하는 도구 이름들 (쓰기 도구) */
  constructor(private readonly gatedTools: string[]) {}

  arm(): void {
    if (this.handler) return;
    this.handler = (w) => {
      if (w.code !== 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') return;
      this.rawMessage = w.message ?? '';
      this.shadowedTools.push(...parseShadowedTools(this.rawMessage));
    };
    process.on('warning', this.handler);
  }

  disarm(): void {
    if (this.handler) {
      process.off('warning', this.handler);
      this.handler = null;
    }
  }

  /** 경고에 실린 전체 목록. 의도한 자동 승인도 포함된다. */
  get shadowed(): string[] { return [...this.shadowedTools]; }

  /** 게이트를 지나야 하는데 가려진 도구. 비어 있지 않으면 사고다. */
  get gatedButShadowed(): string[] {
    return this.gatedTools.filter((t) => this.shadowedTools.includes(t));
  }

  /** 쓰기 도구가 가려졌으면 던진다. 읽기 도구만 가려진 것은 정상이므로 통과시킨다. */
  assertGateIntact(): void {
    const broken = this.gatedButShadowed;
    if (broken.length > 0) {
      throw new Error(
        '승인 게이트가 가려졌다 — 이 도구들이 canUseTool 을 거치지 않고 자동 실행된다: '
        + broken.join(', ')
        + '\n  allowedTools 에서 쓰기 도구를 빼야 한다.'
        + (this.rawMessage ? `\n  SDK 경고: ${this.rawMessage}` : ''),
      );
    }
  }
}

/** 경고 문장에서 가려진 도구 이름을 뽑는다. */
export function parseShadowedTools(message: string): string[] {
  const m = /will not be invoked for:\s*([^.]+)/i.exec(message);
  if (!m || !m[1]) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}
