/**
 * 기간 경계 규약. 화면·CLI 는 until 을 "그 날까지 포함" 으로 적는다
 * ("2026-09-03 ~ 2026-09-10" 은 9/10 하루치를 포함한다는 뜻).
 *
 * 그런데 조회 API 는 until 을 exclusive(그 날 00:00)로 읽는다 —
 * 날짜만 온 until 은 당일 데이터가 통째로 빠져 "배포 0건" 같은 오표시가 났다.
 * 그래서 날짜만 온 until 은 하루를 더해 inclusive day 로 바꾼다.
 * 시각까지 온 값(CLI 의 toISOString 등)은 정확한 instant 이므로 그대로 둔다.
 */
export const DAY_MS = 86_400_000;

/** "2026-09-10" 형태인지. 앞뒤 공백은 무시한다. */
export function isDateOnly(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
}

/**
 * exclusive until(ms). 날짜만 오면 그 날 끝까지 포함한다.
 * 읽히지 않으면 NaN 을 그대로 돌려준다 — 호출자의 invalid_period 검사가 돈다.
 */
export function untilExclusiveMs(until: string): number {
  const t = Date.parse(until);
  if (!Number.isFinite(t)) return NaN;
  return isDateOnly(until) ? t + DAY_MS : t;
}

/** "YYYY-MM-DD" 에 n 일을 더한다. 달력 대조를 마친 값에만 쓴다. */
export function addDays(dateOnly: string, n: number): string {
  const parts = dateOnly.split('-').map(Number);
  const y = parts[0] ?? 0;
  const mo = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  const p = (v: number) => String(v).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
