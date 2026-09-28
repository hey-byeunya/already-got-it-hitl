/**
 * get_system_health 의 live 구현. Vercel REST API.
 *
 * 출력 형태는 픽스처와 **같아야 한다.** 모드에 따라 응답 모양이 달라지면
 * 카드 문안과 render_chart 의 근거 대조가 모드마다 갈라진다.
 *
 * 함수 오류 수는 이 토큰과 플랜으로 조회할 경로가 없다 (관측 API 는 404,
 * 런타임 로그는 배포별·단기 보관이라 주간 집계로 쓸 수 없다).
 * 그래서 **0 이 아니라 결측**으로 내린다 — unavailable_fields 에 담는다.
 * 결측을 0 으로 뭉개면 "오류가 없었다"는 거짓 서술이 카드에 올라간다.
 */
import { FatalToolError } from '../errors.js';
import { pageMayBeTruncated, request, requireEnv } from './http.js';
import { untilExclusiveMs } from './period.js';

const API = 'https://api.vercel.com';

type Deployment = {
  uid?: string; created?: number; state?: string; target?: string | null;
  meta?: Record<string, unknown>; url?: string;
};

/**
 * 찾아갈 수 있는 링크. 배포 URL 과 커밋 URL 을 붙인다 —
 * 빌드 에러가 나면 모델이 이슈 본문에 이 링크를 넣어 사람이 바로 열게 한다.
 * 모르면 null 이다. 자리 문자열을 넣지 않는다.
 */
export function deploymentLinks(d: Deployment): { url: string | null; commit_url: string | null } {
  const url = typeof d.url === 'string' && d.url !== '' ? `https://${d.url}` : null;
  const sha = d.meta?.githubCommitSha;
  const org = d.meta?.githubCommitOrg;
  const repo = d.meta?.githubCommitRepo;
  const host = typeof d.meta?.githubHost === 'string' && d.meta.githubHost !== ''
    ? String(d.meta.githubHost) : 'github.com';
  const commit_url = typeof sha === 'string' && typeof org === 'string' && typeof repo === 'string'
    ? `https://${host}/${org}/${repo}/commit/${sha}` : null;
  return { url, commit_url };
}

export type SystemHealth = {
  period: { since: string; until: string; tz: string };
  deployments: Array<{
    /** 모름은 null 이다. '(id 없음)' 같은 자리 문자열을 넣지 않는다 — 모델이 사실로 읽는다. */
    id: string | null; created_at: string | null; state: string; target: string;
    commit_sha: string | null; build_error: string | null;
    /** 배포 URL·커밋 URL. 모르면 null — 이슈·카드에서 찾아가는 용도다. */
    url: string | null; commit_url: string | null;
  }>;
  summary: { total: number; ready: number; error: number };
  function_errors: { count: number | null; window: string | null; available: boolean };
  unavailable_fields: string[];
  /** 목록 상한(100건)에 걸려 뒤가 잘렸을 수 있는지. 잘린 수를 정확한 합계로 읽지 않게. */
  truncated: boolean;
  truncation_note?: string;
  source: { mode: 'live'; api: string; project_id: string };
};

export async function systemHealth(
  period: { since: string; until: string },
): Promise<SystemHealth> {
  const env = requireEnv('get_system_health', ['VERCEL_API_TOKEN', 'VERCEL_PROJECT_ID']);
  const token = env.VERCEL_API_TOKEN!;
  const projectId = env.VERCEL_PROJECT_ID!;
  const auth = { authorization: `Bearer ${token}` };

  const since = Date.parse(period.since);
  // 날짜만 온 until("2026-09-10")은 그 날 끝까지 포함한다 —
  // 그대로 넘기면 당일 배포가 통째로 빠져 "배포 0건"이 된다 (period.ts).
  const until = untilExclusiveMs(period.until);
  if (!Number.isFinite(since) || !Number.isFinite(until)) {
    throw new FatalToolError('invalid_period', 'period 의 since/until 이 ISO 8601 이 아니다',
      { since: period.since, until: period.until });
  }

  const listed = await request({
    source: 'Vercel',
    url: `${API}/v6/deployments?projectId=${encodeURIComponent(projectId)}`
      + `&since=${since}&until=${until}&limit=100`,
    headers: auth,
    // 목록이 배열이 아니면 빈 기간으로 뭉개지 않는다 — 0건은 사실이어야 한다.
    validate: (v) => Array.isArray((v as { deployments?: unknown } | null)?.deployments),
  }) as { deployments?: Deployment[] };

  const raw = listed.deployments ?? [];
  // 100건 꽉 차면 그 뒤가 잘렸을 수 있다. 잘린 수를 정확한 합계처럼 보고하지 않는다.
  const truncated = pageMayBeTruncated(raw.length, 100);

  // 빌드 오류 원문은 목록 응답에 없다. 실패한 배포만 하나씩 더 물어본다.
  // 전부 물어보면 호출이 배포 수만큼 늘어난다 — 실패한 것만, 최대 5건.
  const failed = raw.filter((d) => d.state === 'ERROR').slice(0, 5);
  const errorText = new Map<string, string | null>();
  for (const d of failed) {
    if (!d.uid) continue;
    try {
      const detail = await request({
        source: 'Vercel',
        url: `${API}/v13/deployments/${encodeURIComponent(d.uid)}`,
        headers: auth,
      }) as Record<string, unknown>;
      const msg = detail.errorMessage ?? detail.errorCode
        ?? (detail.aliasError as { message?: string } | undefined)?.message;
      errorText.set(d.uid, msg ? String(msg) : null);
    } catch {
      // 상세를 못 얻어도 배포 자체는 실패로 보고한다. 원문만 결측으로 둔다.
      errorText.set(d.uid, null);
    }
  }

  const deployments = raw.map((d) => ({
    id: d.uid ?? null,
    created_at: d.created ? new Date(d.created).toISOString() : null,
    state: d.state ?? 'UNKNOWN',
    // target 이 null 인 것은 preview 배포다. null 을 그대로 흘리면 모델이 결측으로 읽는다.
    target: d.target ?? 'preview',
    commit_sha: typeof d.meta?.githubCommitSha === 'string'
      ? (d.meta.githubCommitSha as string).slice(0, 7) : null,
    build_error: d.uid ? (errorText.get(d.uid) ?? null) : null,
    ...deploymentLinks(d),
  }));

  return {
    period: { since: period.since, until: period.until, tz: 'Asia/Seoul' },
    deployments,
    summary: {
      total: deployments.length,
      ready: deployments.filter((d) => d.state === 'READY').length,
      error: deployments.filter((d) => d.state === 'ERROR').length,
    },
    // 조회 경로가 없다. 0 이라고 말하지 않는다.
    function_errors: { count: null, window: null, available: false },
    unavailable_fields: ['function_errors'],
    ...(truncated ? {
      truncated: true,
      truncation_note: '배포가 100건으로 꽉 차 그 뒤는 잘렸을 수 있다. summary 는 처음 100건 기준이다',
    } : { truncated: false }),
    source: { mode: 'live', api: 'vercel/v6/deployments', project_id: projectId },
  };
}
