/**
 * 실행 상세 화면이 쓰는 순수 변환. **화면 요소가 없다** - 여기 것들은 값을 값으로 바꾼다.
 * 화면과 떼어 둔 이유는 하나다. 한 줄 고치려고 1,200줄을 읽지 않기 위해서다 (회고 기록).
 */
import type { CardView, RunLinks, Step, TraceEvent } from '@/lib/types';

/** 트레이스 kind → 글리프와 색. kind 는 원래 저장되는데 전에는 화면이 버렸다. */
export function glyph(e: TraceEvent): { mark: string; cls: string; group: 'tool' | 'think' | 'err' } {
  if (e.isError || e.kind === 'error' || e.kind === 'hook_denied') {
    return { mark: '✕', cls: 'bad', group: 'err' };
  }
  switch (e.kind) {
    case 'tool_use': return { mark: '→', cls: 'ok', group: 'tool' };
    case 'tool_result': return { mark: '←', cls: 'mut', group: 'tool' };
    case 'question_waiting': return { mark: '?', cls: 'wrn', group: 'think' };
    case 'question_answered':
    case 'question_declined': return { mark: '?', cls: 'mut', group: 'think' };
    case 'approval_waiting': return { mark: '!', cls: 'bad', group: 'think' };
    case 'approval_granted': return { mark: '✓', cls: 'ok', group: 'think' };
    case 'approval_denied': return { mark: '✕', cls: 'bad', group: 'think' };
    case 'stopped': return { mark: '■', cls: 'wrn', group: 'err' };
    default: return { mark: '·', cls: 'mut', group: 'think' };
  }
}

/** 카드의 출처 문장이 web_search 를 가리키면, 그 검색이 돌려준 주소를 붙인다. */
export function webSourcesFor(card: CardView, links: RunLinks): RunLinks['web'] {
  if (!links.web.length) return [];
  if (!card.sources.some((x) => x.includes('web_search'))) return [];
  // 출처 문장에 제목이 적혀 있으면 그것만, 없으면 이 실행의 검색 출처 전부.
  const named = links.web.filter((w) => card.sources.some((x) => x.includes(w.title)));
  return named.length ? named : links.web;
}


export const kb = (b: number) => `${Math.round(b / 1024).toLocaleString()}KB`;
/**
 * 로그 한 줄의 시각. **현지 시각으로 고친다.**
 *
 * 기록은 ISO UTC 로 남는다. 예전에는 그 문자열을 그대로 잘라 썼는데(`slice(11,19)`),
 * 같은 화면의 created 는 현지 시각이라 두 값이 9시간 어긋나 보였다.
 * 저장은 UTC 로 두고 — 기계끼리 견줄 값이다 — 읽는 자리에서만 고친다.
 */
export function hhmmss(v: string): string {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return v.slice(11, 19);
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 사람이 읽을 시각. 초는 버린다. */
export function stamp(v: string): string {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return v;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const SEVERITY: Record<CardView['severity'], { line: string; bg: string; ink: string }> = {
  FIX_NOW: { line: 'var(--danger)', bg: 'rgba(226,96,75,.16)', ink: 'var(--danger-ink)' },
  WATCH: { line: 'var(--warn)', bg: 'rgba(232,192,78,.14)', ink: 'var(--warn)' },
  METRICS: { line: 'var(--muted)', bg: 'var(--line-in)', ink: 'var(--muted)' },
  FYI: { line: 'var(--muted)', bg: 'var(--line-in)', ink: 'var(--muted)' },
  COVER: { line: 'var(--accent)', bg: 'rgba(78,224,138,.14)', ink: 'var(--accent)' },
};

export const STEP_MARK: Record<Step['state'], { g: string; cls: string }> = {
  done: { g: '✓', cls: 'ok' },
  current: { g: '◆', cls: 'wrn' },
  pending: { g: '·', cls: 'mut' },
};

export function credLine(src?: 'api_key' | 'auth_token' | 'stored_login'): string {
  switch (src) {
    case 'api_key': return 'ANTHROPIC_API_KEY (API 크레딧에서 빠진다)';
    case 'auth_token': return 'ANTHROPIC_AUTH_TOKEN';
    case 'stored_login': return '저장된 로그인(구독)';
    default: return '기록되지 않음';
  }
}

/** 승인 요약에서 사람이 먼저 봐야 하는 줄만 뽑는다. 전문은 --diff 로 본다. */
export function summaryLines(summary: Record<string, unknown>): [string, string][] {
  const pick = ['repo', 'title', 'labels', 'issue_number', 'reason'];
  const out: [string, string][] = [];
  for (const k of pick) {
    const v = summary[k];
    if (v === undefined || v === null) continue;
    out.push([k, Array.isArray(v) ? `[${v.join(', ')}]` : String(v)]);
  }
  const src = summary.source as { tool?: unknown; field?: unknown } | undefined;
  if (src?.tool) out.push(['근거', `${String(src.tool)}${src.field ? ` → ${String(src.field)}` : ''}`]);
  return out;
}
