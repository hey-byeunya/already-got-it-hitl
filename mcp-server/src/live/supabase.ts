/**
 * get_user_metrics 의 live 구현. Supabase 집계 전용 RPC.
 *
 * 이 파일은 테이블을 직접 조회하지 않는다. RPC 하나만 부른다 (DECISIONS.md D10).
 * service_role 키는 읽지도 않는다 — 코드에 그 이름이 없다.
 *
 * 함수가 아직 없거나 토큰이 어긋나면 상류 오류를 그대로 흘리지 않고
 * **무엇을 하면 되는지** 담아 되돌린다. 모델이 헛되게 재시도하지 않게.
 */
import { FatalToolError, ToolError } from '../errors.js';
import { request, requireEnv } from './http.js';
import { addDays, isDateOnly } from './period.js';

const RPC = 'ops_user_metrics';

/**
 * 관측 대상 앱의 공개 URL. 에러 route("/items/..." 등)를 찾아갈 수 있는 링크로 바꾼다.
 * `action:` 접두 Server Action 은 페이지가 아니라 링크가 없다 (null).
 */
export const APP_BASE_URL = 'https://already-got-it.vercel.app';

/** route 를 찾아갈 수 있는 URL 로 바꾼다. 페이지가 아니면 null 이다. */
export function routeUrl(route: string): string | null {
  return route.startsWith('/') ? `${APP_BASE_URL}${route}` : null;
}

/** ISO 8601 이든 YYYY-MM-DD 이든 날짜 부분만 쓴다. RPC 인자가 date 다. */
export function toDate(v: string, which: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) {
    // 2026-13-99 같은 문자열도 정규식은 통과한다. 달력에 있는 날짜인지 대조한다.
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) {
      return `${m[1]}-${m[2]}-${m[3]}`;
    }
    throw new FatalToolError('invalid_period', `${which} 가 실제 날짜가 아니다`, { [which]: v });
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) {
    throw new FatalToolError('invalid_period', `${which} 가 날짜로 읽히지 않는다`, { [which]: v });
  }
  return new Date(t).toISOString().slice(0, 10);
}

function upstreamCode(err: unknown): string | undefined {
  if (err instanceof ToolError) {
    const u = err.extra.upstream as { code?: unknown } | undefined;
    if (u && typeof u.code === 'string') return u.code;
  }
  return undefined;
}

export async function userMetrics(
  period: { since: string; until: string },
  granularity: 'day' | 'week',
): Promise<Record<string, unknown>> {
  const env = requireEnv('get_user_metrics', [
    'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'OPS_METRICS_TOKEN',
  ]);
  const url = env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/+$/, '');
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  let out: unknown;
  // RPC 는 until 을 exclusive 로 읽는다. 날짜만 온 until 은 하루를 더해
  // 그 날 하루치를 포함한다 — 그대로 넘기면 당일 집계가 통째로 빠진다 (period.ts).
  const untilDate = toDate(period.until, 'until');
  const pUntil = isDateOnly(period.until) ? addDays(untilDate, 1) : untilDate;
  try {
    out = await request({
      source: 'Supabase',
      method: 'POST',
      url: `${url}/rest/v1/rpc/${RPC}`,
      headers: { apikey: key, authorization: `Bearer ${key}` },
      body: {
        p_token: env.OPS_METRICS_TOKEN!,
        p_since: toDate(period.since, 'since'),
        p_until: pUntil,
        p_granularity: granularity,
      },
    });
  } catch (err) {
    // PGRST202 = 스키마 캐시에 그런 함수가 없다. 마이그레이션을 아직 안 돌린 것이다.
    if (upstreamCode(err) === 'PGRST202') {
      throw new FatalToolError('rpc_not_created',
        `Supabase 에 집계 함수 ${RPC} 가 없다. supabase/ops_metrics.sql 을 SQL Editor 에서 실행한다`,
        { rpc: RPC, sql_file: 'supabase/ops_metrics.sql' });
    }
    // 42501 = insufficient_privilege. 함수 안에서 토큰 대조가 실패했다.
    if (upstreamCode(err) === '42501') {
      throw new FatalToolError('metrics_token_rejected',
        'OPS_METRICS_TOKEN 이 Supabase 에 저장된 값과 다르다. 값은 사람이 직접 맞춘다',
        { rpc: RPC, sql_file: 'supabase/ops_metrics.sql' });
    }
    throw err;
  }

  if (!out || typeof out !== 'object') {
    throw new ToolError('unexpected_rpc_shape', '집계 함수가 객체를 돌려주지 않는다', { got: typeof out });
  }
  const data = { ...(out as Record<string, unknown>) };
  // 에러 다발 route 에 찾아갈 링크를 붙인다. 이슈 본문·카드에서 바로 열게 한다.
  // route 가 페이지가 아니면(null) 이름만 남긴다 — 없는 링크를 지어내지 않는다.
  if (Array.isArray(data.errors_by_route)) {
    data.errors_by_route = (data.errors_by_route as Array<Record<string, unknown>>).map((e) => ({
      ...e,
      url: typeof e.route === 'string' ? routeUrl(e.route) : null,
    }));
  }
  return { ...data, source: { mode: 'live', rpc: RPC } };
}
