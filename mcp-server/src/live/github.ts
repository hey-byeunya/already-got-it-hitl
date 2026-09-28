/**
 * get_dev_activity · create_github_issue · revert_issue 의 live 구현.
 *
 * 이 파일은 **이슈 읽기·생성·닫기** 세 가지만 부른다.
 * 삭제 경로는 아예 코드에 없다 — 토큰 범위와 별개로, 부를 함수가 없으면 부를 수 없다.
 */
import { ToolError } from '../errors.js';
import { pageMayBeTruncated, request, requireEnv } from './http.js';
import { untilExclusiveMs } from './period.js';

const API = 'https://api.github.com';

function headers(): Record<string, string> {
  const env = requireEnv('github', ['GITHUB_TOKEN']);
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN!}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
}

const days = (from: string, to: number) =>
  Math.max(0, Math.round((to - Date.parse(from)) / 86_400_000));

type Issue = {
  number: number; title: string; created_at: string;
  labels?: Array<{ name?: string } | string>;
  pull_request?: unknown;
};
type Commit = { commit?: { author?: { name?: string } }; author?: { login?: string } };
type Pull = {
  number: number; title: string; state: string; draft?: boolean;
  created_at: string; merged_at?: string | null;
};

const labelNames = (ls: Issue['labels']): string[] =>
  (ls ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean);

export async function devActivity(
  repo: string, period: { since: string; until: string },
): Promise<Record<string, unknown>> {
  const h = headers();
  // 날짜만 온 until 은 그 날 끝까지 포함한다 — 그대로 쓰면 당일 병합이 빠진다 (period.ts).
  const now = untilExclusiveMs(period.until);
  const q = `since=${encodeURIComponent(period.since)}&until=${encodeURIComponent(period.until)}`;

  const [issuesRaw, commitsRaw, openPulls, closedPulls] = await Promise.all([
    request({ source: 'GitHub', url: `${API}/repos/${repo}/issues?state=open&per_page=100`, headers: h,
      validate: Array.isArray }),
    request({ source: 'GitHub', url: `${API}/repos/${repo}/commits?${q}&per_page=100`, headers: h,
      validate: Array.isArray }),
    request({ source: 'GitHub', url: `${API}/repos/${repo}/pulls?state=open&per_page=100`, headers: h,
      validate: Array.isArray }),
    request({ source: 'GitHub',
      url: `${API}/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`, headers: h,
      validate: Array.isArray }),
  ]);

  // /issues 는 PR 도 함께 돌려준다. pull_request 가 붙은 것은 이슈가 아니다.
  // (이걸 걸러내지 않으면 열린 이슈 수가 PR 만큼 부풀어 카드의 숫자가 틀린다.)
  const issues = (issuesRaw as Issue[]).filter((i) => !i.pull_request);
  const commits = commitsRaw as Commit[];
  const authors = new Set(commits.map((c) => c.author?.login ?? c.commit?.author?.name ?? '?'));

  const mergedThisPeriod = (closedPulls as Pull[]).filter((p) => {
    if (!p.merged_at) return false;
    const t = Date.parse(p.merged_at);
    return t >= Date.parse(period.since) && t <= now;
  });

  const openIssues = issues.map((i) => ({
    number: i.number, title: i.title, created_at: i.created_at,
    age_days: days(i.created_at, now), labels: labelNames(i.labels),
  }));

  // 한 페이지 상한에 꽉 차면 그 뒤가 잘렸을 수 있다. 잘린 수를 정확한 합계처럼 보고하지 않는다.
  const truncated = pageMayBeTruncated((issuesRaw as unknown[]).length, 100)
    || pageMayBeTruncated(commits.length, 100)
    || pageMayBeTruncated((openPulls as unknown[]).length, 100);

  return {
    open_issues: openIssues,
    commits: { count: commits.length, authors: authors.size },
    pull_requests: (openPulls as Pull[]).map((p) => ({
      number: p.number, title: p.title, state: p.state, draft: p.draft === true,
      created_at: p.created_at,
    })),
    summary: {
      open_issue_count: openIssues.length,
      oldest_open_issue_days: openIssues.length
        ? Math.max(...openIssues.map((i) => i.age_days)) : 0,
      merged_this_period: mergedThisPeriod.length,
    },
    unavailable_fields: [],
    ...(truncated ? {
      truncated: true,
      truncation_note: '목록이 페이지 상한에 걸려 뒤가 잘렸을 수 있다. 합계는 첫 페이지 기준이다',
    } : { truncated: false }),
    source: { mode: 'live', api: 'github/repos', repo },
  };
}

export async function createIssue(
  repo: string, body: { title: string; body: string; labels: string[] },
): Promise<{ number: number; url: string; state: string }> {
  const created = await request({
    source: 'GitHub', method: 'POST', headers: headers(),
    url: `${API}/repos/${repo}/issues`, body,
  }) as { number?: number; html_url?: string; state?: string };

  if (typeof created.number !== 'number') {
    throw new ToolError('upstream_error', 'GitHub 이 이슈 번호를 돌려주지 않았다',
      { repo, upstream: created });
  }
  return {
    number: created.number,
    url: created.html_url ?? `https://github.com/${repo}/issues/${created.number}`,
    state: created.state ?? 'open',
  };
}

/**
 * 닫기만 한다. 삭제하지 않는다.
 * 되돌린 이유를 코멘트로 먼저 남긴다 — 닫힌 이슈만 남으면 왜 닫혔는지 알 수 없다.
 */
export async function closeIssue(
  repo: string, issueNumber: number, reason: string,
): Promise<{ number: number; state: string; url: string }> {
  const h = headers();
  try {
    await request({
      source: 'GitHub', method: 'POST', headers: h,
      url: `${API}/repos/${repo}/issues/${issueNumber}/comments`,
      body: { body: `되돌림 (운영 브리핑 에이전트): ${reason}` },
    });
  } catch {
    // 코멘트를 못 남겨도 닫기는 진행한다. 닫히지 않고 남는 편이 더 나쁘다.
  }
  const closed = await request({
    source: 'GitHub', method: 'PATCH', headers: h,
    url: `${API}/repos/${repo}/issues/${issueNumber}`,
    body: { state: 'closed', state_reason: 'not_planned' },
  }) as { number?: number; state?: string; html_url?: string };

  return {
    number: closed.number ?? issueNumber,
    state: closed.state ?? 'closed',
    url: closed.html_url ?? `https://github.com/${repo}/issues/${issueNumber}`,
  };
}
