/**
 * web_search 의 live 구현.
 *
 * 범용 웹 검색 API 키를 새로 발급받지 않고, 도구 설명이 이미 좁혀 놓은 범위를
 * 그대로 구현했다 (DECISIONS.md D19) — description 은 "이 앱이 실제로 쓰는
 * 의존성의 릴리스 노트나 보안 권고를 찾을 때만 호출한다" 고 말한다.
 * 그래서 두 출처만 본다.
 *
 *   npm registry            : 최신 버전과 배포 시각 (키 없음)
 *   GitHub Advisory Database: 그 패키지의 보안 권고 (이미 있는 GITHUB_TOKEN)
 *
 * 이 편이 범용 검색보다 나은 점: 결과가 결정적이고, 게시일이 실제 값이며,
 * 앱이 쓰지 않는 패키지 이야기가 섞여 들어오지 않는다.
 * 못 하는 것: 의존성과 무관한 일반 IT 트렌드. README 「밝혀 두는 것」에 적는다.
 */
import { request } from './http.js';
import { WATCHED_PACKAGES as WATCHED } from '../config.js';

export type SearchResult = {
  title: string; url: string; snippet: string; published_at: string | null;
  kind: 'release' | 'advisory'; package: string; severity?: string;
};

/** 검색어에서 감시 대상 패키지를 골라낸다. 하나도 안 걸리면 전부 본다. */
function pick(query: string): string[] {
  const q = query.toLowerCase();
  const hit = WATCHED.filter((p) => q.includes(p.toLowerCase())
    || q.includes(p.replace(/^@[^/]+\//, '').toLowerCase()));
  return hit.length ? hit : WATCHED;
}

async function latestRelease(pkg: string): Promise<SearchResult | null> {
  try {
    const d = await request({
      source: 'npm registry',
      url: `https://registry.npmjs.org/${pkg.replace('/', '%2F')}`,
    }) as { 'dist-tags'?: Record<string, string>; time?: Record<string, string>;
            versions?: Record<string, { description?: string }> };
    const latest = d['dist-tags']?.latest;
    if (!latest) return null;
    return {
      title: `${pkg} ${latest}`,
      url: `https://www.npmjs.com/package/${pkg}/v/${latest}`,
      snippet: d.versions?.[latest]?.description ?? `${pkg} 의 npm 최신 배포 버전`,
      // 게시일을 모르면 null 로 둔다. 도구 설명이 "null 은 미확인으로 표시" 라고 약속했다.
      published_at: d.time?.[latest]?.slice(0, 10) ?? null,
      kind: 'release', package: pkg,
    };
  } catch { return null; }
}

async function advisories(pkg: string, token: string | undefined): Promise<SearchResult[]> {
  try {
    const list = await request({
      source: 'GitHub Advisory Database',
      url: 'https://api.github.com/advisories?ecosystem=npm&per_page=5'
        + `&affects=${encodeURIComponent(pkg)}`,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }) as Array<{ ghsa_id?: string; summary?: string; html_url?: string;
                  published_at?: string; severity?: string }>;
    if (!Array.isArray(list)) return [];
    return list.map((a) => ({
      title: `[보안 권고 ${a.severity ?? '등급 미확인'}] ${pkg} — ${a.summary ?? a.ghsa_id ?? ''}`,
      url: a.html_url ?? `https://github.com/advisories/${a.ghsa_id ?? ''}`,
      snippet: a.summary ?? '(요약 없음)',
      published_at: a.published_at?.slice(0, 10) ?? null,
      kind: 'advisory' as const, package: pkg, severity: a.severity ?? undefined,
    }));
  } catch { return []; }
}

export async function search(
  query: string, maxResults: number,
): Promise<Record<string, unknown>> {
  const packages = pick(query);
  const token = process.env.GITHUB_TOKEN?.trim() || undefined;

  const settled = await Promise.all(packages.flatMap((p) => [
    latestRelease(p).then((r) => (r ? [r] : [])),
    advisories(p, token),
  ]));
  const all = settled.flat();

  // 보안 권고를 릴리스 앞에 둔다. 급한 것이 먼저 보여야 한다.
  all.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'advisory' ? -1 : 1;
    return (b.published_at ?? '').localeCompare(a.published_at ?? '');
  });

  return {
    query,
    results: all.slice(0, maxResults),
    searched_packages: packages,
    source: { mode: 'live', apis: ['registry.npmjs.org', 'api.github.com/advisories'] },
    scope_note: '이 도구는 앱이 쓰는 의존성의 릴리스·보안 권고만 본다. 일반 웹 검색이 아니다',
    unavailable_fields: [],
  };
}
