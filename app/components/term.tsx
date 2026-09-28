/**
 * 터미널 화면의 공통 조각. 두 화면이 함께 쓰는 것만 둔다.
 *
 * 상태 → 라벨·색 대응을 **여기 한 곳에만** 둔다.
 * 전에는 CSS 클래스(.badge.done 등)에만 있어서 TS 쪽에서 읽을 수 없었고,
 * 같은 판단을 화면마다 다시 쓰게 돼 있었다.
 */
import type { RunStatus } from '../lib/types';

export const TERMINAL_STATUSES = new Set<RunStatus>(['done', 'stopped', 'failed', 'interrupted']);

type Tone = 'ok' | 'warn' | 'bad' | 'mut';

const TONE_VAR: Record<Tone, string> = {
  ok: 'var(--accent)',
  warn: 'var(--warn)',
  bad: 'var(--danger-ink)',
  mut: 'var(--muted)',
};

/** 상태 한 줄. pending_approval 이 걸려 있으면 같은 waiting_for_user 라도 더 급한 색이다. */
export function statusFace(
  status: RunStatus,
  opts: { pendingApproval?: boolean } = {},
): { text: string; tone: Tone } {
  switch (status) {
    case 'waiting_for_user':
      return opts.pendingApproval
        ? { text: 'APPROVAL_PENDING', tone: 'bad' }
        : { text: 'WAITING_FOR_USER', tone: 'warn' };
    case 'interrupted': return { text: 'INTERRUPTED', tone: 'warn' };
    case 'stopped': return { text: 'STOPPED', tone: 'warn' };
    case 'failed': return { text: 'FAILED', tone: 'bad' };
    case 'done': return { text: 'DONE', tone: 'ok' };
    case 'running': return { text: 'RUNNING', tone: 'ok' };
    case 'planning': return { text: 'PLANNING', tone: 'ok' };
    default: return { text: String(status).toUpperCase(), tone: 'mut' };
  }
}

export function StatusBadge({ status, pendingApproval }: {
  status: RunStatus; pendingApproval?: boolean;
}) {
  const { text, tone } = statusFace(status, { pendingApproval });
  return (
    <span className="badge" style={{ color: TONE_VAR[tone] }}>
      <i />{text}
    </span>
  );
}

/**
 * 구역 머리글. `label` 은 노드도 받는다 — 머리글 안의 낱말마다 색을 달리 줘야 할 때가 있다
 * ([ RUNS ] 의 ok·halted·failed 처럼). 그 경우 읽어 줄 글자를 `labelText` 로 따로 준다.
 */
export function SectionHead({ label, labelText, right, tone = 'ok', hint }: {
  label: React.ReactNode; labelText?: string; right?: React.ReactNode; tone?: Tone; hint?: string;
}) {
  const text = labelText ?? (typeof label === 'string' ? label : undefined);
  return (
    <div className="spread" style={{ marginBottom: 12 }}>
      <span className="sechead" style={{ color: TONE_VAR[tone] }}
        {...(hint ? { 'data-tip': hint, 'aria-label': text ? `${text}: ${hint}` : hint } : {})}>
        {label}
      </span>
      {right}
    </div>
  );
}

export function Lights() {
  return <span className="lights"><i /><i /><i /></span>;
}

export function Cursor() {
  return <span className="cursor" />;
}

const CELLS = 20;

/**
 * ASCII 게이지. 채운 칸과 빈 칸을 **색으로만** 나눈다.
 *
 * value 가 null 이면 "모른다"는 뜻이다 — 0 으로 그리지 않는다.
 * 0 으로 그리면 "아무것도 안 썼다"는 거짓말이 된다 (usage_known 과 같은 문제).
 */
export function Bar({ value, max, tone = 'mut' }: {
  value: number | null; max: number; tone?: Tone;
}) {
  if (value === null || !Number.isFinite(max) || max <= 0) {
    return (
      <div className="bar" style={{ color: 'var(--bar-empty)' }}>
        {'█'.repeat(CELLS)} <span className="mut">-</span>
      </div>
    );
  }
  const ratio = Math.max(0, Math.min(1, value / max));
  const over = value > max;
  const filled = over ? CELLS : Math.round(ratio * CELLS);
  const pct = Math.round(ratio * 100);
  return (
    <div className="bar" style={{ color: over ? 'var(--warn)' : TONE_VAR[tone] }}>
      {'█'.repeat(filled)}
      <span className="empty">{'█'.repeat(CELLS - filled)}</span>
      {' '}
      {over ? <span className="wrn">상한</span> : `${pct}%`}
    </div>
  );
}

/**
 * 게이지 한 줄 — 이름 · 분수 · 막대.
 *
 * 단서는 `hint` 로 받아 **툴팁**에 둔다. 게이지 아래에 문단으로 깔면
 * 계기 세 칸 중 하나만 설명이 길어져 눈이 그리로 쏠린다.
 */
export function Gauge({ label, value, max, unit, prefix, digits, tone, hint }: {
  label: string; value: number | null; max: number;
  unit?: string; prefix?: string; digits?: number; tone?: Tone; hint?: string;
}) {
  const show = (n: number) => `${prefix ?? ''}${fmt(n, digits)}${unit ?? ''}`;
  return (
    // tabIndex 를 열어 키보드로도 툴팁에 닿게 한다 — 마우스만 되는 설명은 반쪽이다.
    <div {...(hint
      ? { 'data-tip': hint, 'data-tip-align': 'right', 'aria-label': `${label}: ${hint}`, tabIndex: 0 }
      : {})}>
      <div className="spread" style={{ marginBottom: 4 }}>
        <span className="mut">{label}</span>
        <span className={value === null ? 'wrn' : 'ink'}>
          {value === null ? '확인 못 함' : show(value)} / {show(max)}
        </span>
      </div>
      <Bar value={value} max={max} tone={tone} />
    </div>
  );
}

function fmt(n: number, digits?: number): string {
  if (digits !== undefined) return n.toFixed(digits);
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
}

/** 초 → MM:SS. 실행 경과 표시에 쓴다. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export { TONE_VAR };
export type { Tone };
