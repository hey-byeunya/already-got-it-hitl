/**
 * 도메인 도구 9개. description 은 TOOLS.md 와 같은 계약을 따른다 —
 * 설명에 쓴 제약과 함수의 실제 검사가 어긋나면 설명은 아무것도 제한하지 못한다.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { config, isFixtureMode } from './config.js';
import { FatalToolError, ToolError } from './errors.js';
import { fixtureResponse, listFixtureIds } from './fixtures.js';
import { baseInput, defineTool } from './register.js';
import { openRun, runPath } from './runlog.js';
import { consume, appendLog, createdIssueNumbers, createdIssueRepo, isAlreadyReverted } from './approvals.js';
import { renderBarChart, verifySource, verifySourceRow, writeSvg, type ChartPoint } from './chart.js';
import {
  CARD_CATEGORIES, CATEGORY_ACCENT, COVER_TITLE, MAX_CARDS, MIN_CARDS, checkCategory, composeCard,
  exportCardnews, normalizeTitle, type CardSpec,
} from './cards.js';
import { systemHealth } from './live/vercel.js';
import { userMetrics } from './live/supabase.js';
import { devActivity, createIssue, closeIssue } from './live/github.js';
import { search as searchAdvisories } from './live/advisories.js';

const period = {
  since: z.string().describe('기간 시작 (ISO 8601)'),
  until: z.string().describe('기간 끝 (ISO 8601)'),
};



/**
 * live 모드에서 실제 쓰기를 허용하는 별도 스위치.
 *
 * 사람의 승인(게이트 ①②③)과 이것은 다른 질문이다.
 *   승인            = "이 이슈 내용이 맞다"
 *   OPS_ALLOW_LIVE_WRITES = "실제 공개 저장소를 바꿔도 된다"
 * live 로 읽기만 돌려 보는 동안 실수로 실제 이슈가 생기지 않게 기본값을 꺼 둔다.
 */
function requireLiveWrites(tool: string): void {
  if (process.env.OPS_ALLOW_LIVE_WRITES !== '1') {
    throw new FatalToolError('live_writes_disabled',
      `live 모드지만 실제 쓰기가 꺼져 있다. 실제 저장소를 바꾸려면 OPS_ALLOW_LIVE_WRITES=1 로 실행한다`,
      { tool, hint: '읽기 도구는 이 스위치와 무관하게 live 로 동작한다' });
  }
}

/** 이 실행이 render_chart 로 만든 차트 파일들. 오류에 회복 정보로 담는다. */
function listChartFiles(runId: string): string[] {
  const dir = runPath(runId, 'charts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.svg')).sort().map((f) => `charts/${f}`);
}

/** 이 실행에 이미 만들어진 카드 번호들. */
function listCardNumbers(runId: string): number[] {
  const dir = runPath(runId, 'cards');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))
    .map((f) => Number(f.replace('.json', ''))).sort((a, b) => a - b);
}

/** 승인 기록에서 그 이슈를 만든 저장소를 찾는다. 기록에 없으면 닫지 않는다. */
function repoOfCreatedIssue(runId: string, issueNumber: number): string {
  const repo = createdIssueRepo(runId, issueNumber);
  if (!repo) {
    throw new ToolError('not_in_approval_log',
      '승인 기록에 이 이슈를 만든 저장소가 없다', { issue_number: issueNumber });
  }
  return repo;
}

/** 픽스처 응답이 error 를 담고 있으면 그대로 도구 오류로 올린다 — 실패 경로도 재현한다. */
function passthroughOrThrow(tool: string, value: unknown): unknown {
  if (value && typeof value === 'object' && 'error' in (value as Record<string, unknown>)) {
    const v = value as Record<string, unknown>;
    throw new ToolError(String(v.error), String(v.message ?? '픽스처가 재현한 실패'), {
      ...v, tool, reproduced_from: 'fixture',
    });
  }
  return value;
}

export function registerAllTools(server: McpServer): void {
  // ─────────────────────────────────────────────────────────── 1. 시스템 상태
  defineTool(server, {
    name: 'get_system_health',
    description:
      '「이미 있어」의 배포와 실행 상태를 가져온다. 시스템이 이번 기간에 문제가 없었는지 확인할 때 '
      + '가장 먼저 호출한다. 배포 성공/실패, 빌드 오류 원문, 함수 오류 수를 돌려준다. '
      + '배포마다 찾아갈 링크(`url`·`commit_url`)가 있다 — 빌드 에러를 이슈·카드에 적을 때 함께 쓴다. '
      + '시스템 상태를 추측하지 말고 반드시 이 도구로 확인한다. '
      + 'unavailable_fields 에 담긴 항목은 조회하지 못한 것이며 0 이 아니다 — 결측과 0 을 구별해 서술한다.',
    inputSchema: z.object({ ...baseInput, ...period }),
    handler: async ({ run_id, since, until }) => {
      const meta = openRun(run_id);
      if (meta.mode === 'live') return systemHealth({ since, until });
      return passthroughOrThrow('get_system_health', fixtureResponse(meta.fixture_id!, 'get_system_health'));
    },
  });

  // ─────────────────────────────────────────────────────────── 2. 사용자 지표
  defineTool(server, {
    name: 'get_user_metrics',
    description:
      '「이미 있어」 사용자 활동의 집계 지표를 가져온다. 가입 추이, 있템·위시 등록 수, 활성 사용자를 '
      + '기간별로 돌려준다. 개별 사용자나 개별 물건은 조회할 수 없다 — 이 도구는 집계값만 반환한다. '
      + '에러 다발 route(`errors_by_route`)마다 찾아갈 링크(`url`)가 있다 — 앱 에러를 이슈·카드에 적을 때 함께 쓴다. '
      + 'previous_period_totals 가 있어야 늘었는지 줄었는지 말할 수 있다. null 이면 비교하지 않는다.',
    inputSchema: z.object({ ...baseInput, ...period,
      granularity: z.enum(['day', 'week']).default('day').describe('집계 단위') }),
    handler: async ({ run_id, since, until, granularity }) => {
      const meta = openRun(run_id);
      if (meta.mode === 'live') return userMetrics({ since, until }, granularity);
      return passthroughOrThrow('get_user_metrics', fixtureResponse(meta.fixture_id!, 'get_user_metrics'));
    },
  });

  // ─────────────────────────────────────────────────────────── 3. 개발 활동
  defineTool(server, {
    name: 'get_dev_activity',
    description:
      '저장소의 개발 활동을 가져온다. 열린 이슈, 기간 내 커밋, PR 상태를 돌려준다. '
      + '무엇이 쌓이고 있고 무엇이 멈춰 있는지 판단할 때 호출한다. '
      + '이슈를 만들거나 닫지는 않는다 — 그건 create_github_issue 와 revert_issue 의 일이다.',
    inputSchema: z.object({ ...baseInput, ...period,
      repo: z.string().describe('owner/name 형식. 허용 목록 밖은 거절된다') }),
    handler: async ({ run_id, repo, since, until }) => {
      // 허용 목록 검사가 모드보다 먼저다. live 든 fixture 든 범위 밖은 거절한다.
      if (!config.allowedRepos.includes(repo)) {
        throw new FatalToolError('repo_not_allowed', '허용 목록에 없는 저장소다', {
          repo, allowed: config.allowedRepos,
        });
      }
      const meta = openRun(run_id);
      if (meta.mode === 'live') return devActivity(repo, { since, until });
      return passthroughOrThrow('get_dev_activity', fixtureResponse(meta.fixture_id!, 'get_dev_activity'));
    },
  });

  // ─────────────────────────────────────────────────────────── 4. 웹 검색
  defineTool(server, {
    name: 'web_search',
    description:
      '이 앱이 실제로 쓰는 의존성의 릴리스 노트나 보안 권고를 찾을 때만 호출한다. '
      + '시스템 상태나 사용자 지표를 알아내는 용도로는 쓰지 않는다 — 그건 앞의 세 도구의 일이다. '
      + '검색 결과 요약만으로 카드의 핵심 사실을 확정하지 않는다. '
      + 'published_at 이 null 인 결과는 게시일 미확인으로 표시한다.',
    inputSchema: z.object({ ...baseInput,
      query: z.string().describe('검색어'),
      max_results: z.number().int().min(1).max(10).default(5) }),
    handler: async ({ run_id, query, max_results }) => {
      const meta = openRun(run_id);
      if (meta.mode === 'live') return searchAdvisories(query, max_results);
      return passthroughOrThrow('web_search', fixtureResponse(meta.fixture_id!, 'web_search'));
    },
  });

  // ─────────────────────────────────────────────────────────── 5. 차트
  defineTool(server, {
    name: 'render_chart',
    description:
      '앞선 조회 도구가 돌려준 값으로 카드에 넣을 SVG 차트를 그린다. '
      + 'source 필드가 필수다 — 어느 도구의 어느 값을 그리는지 밝혀야 한다. '
      + '직접 입력한 수치나 기억한 수치로는 차트를 그릴 수 없다. data 의 값이 source 가 가리키는 '
      + '결과에 실제로 없으면 source_mismatch 로 거절된다. '
      + '먼저 해당 조회 도구를 호출한 뒤에 쓴다. '
      + 'source.tool 은 짧은 이름(get_user_metrics)이든 붙여 부르는 이름이든 모두 받는다. '
      + 'source.field 는 숫자를 가리키거나(series[].signups), 숫자들을 담은 객체를 가리켜도 된다(totals).',
    inputSchema: z.object({ ...baseInput,
      card_no: z.number().int().min(1).describe('몇 번째 카드인가'),
      chart_type: z.enum(['bar']).default('bar').describe('현재는 bar 만 지원한다'),
      source: z.object({
        tool: z.string().describe('근거가 된 도구 이름. 이 실행에서 실제로 호출했어야 한다'),
        field: z.string().describe('그 도구 결과 안의 경로. 예: series[].signups, totals.active_users'),
        run_step: z.number().int().optional(),
      }).describe('근거. 없으면 차트를 그리지 않는다'),
      data: z.array(z.object({ label: z.string(), value: z.number() })).min(1),
      title: z.string(),
      highlight: z.object({ label: z.string(), note: z.string().optional() }).nullable().default(null),
    }),
    handler: ({ run_id, card_no, source, data, title, highlight }) => {
      // 근거 대조가 먼저다. 통과하지 못하면 파일을 만들지 않는다.
      verifySource(run_id, source, data as ChartPoint[]);

      const svg = renderBarChart({ title, data: data as ChartPoint[], highlight });
      const rel = `charts/${String(card_no).padStart(2, '0')}.svg`;
      const abs = runPath(run_id, rel);
      const { bytes, rendered_ok } = writeSvg(abs, svg);

      if (!rendered_ok) {
        throw new ToolError('render_failed', 'SVG 를 만들었지만 유효한 파일로 열리지 않는다', {
          card_no, path: rel, bytes,
        });
      }
      return { card_no, svg_path: rel, bytes, rendered_ok, source_verified: true, source };
    },
  });

  // ───────────────────────────────────────────── 8. 카드 합성 (텍스트 레이어)
  defineTool(server, {
    name: 'compose_card',
    description:
      '카드 한 장을 만든다. 제목·본문·출처가 **각각 별도 텍스트 레이어**로 들어가고, '
      + '같은 내용이 데이터로도 저장돼 나중에 한 장만 고칠 수 있다. '
      + 'chart_path 에 render_chart 가 만든 경로를 주면 그 파일을 **읽어서** 끼워 넣는다 — '
      + '차트를 다시 그리지 않으므로 텍스트만 고칠 때 그림이 바뀌지 않는다. '
      + 'sources 는 비울 수 없다. 각 행은 "도구 · 필드" 형식이어야 한다. '
      + '예: "get_user_metrics · totals.active_users". 필드 뒤 괄호 메모는 허용된다. '
      + 'cover 가 아닌 카드는 각 행이 이번 실행의 실제 호출·값을 가리키는지 대조하고, '
      + '어긋나면 source_shape_invalid·source_not_found·source_field_empty 로 거절한다. '
      + 'cover 는 요약 성격이라 빈 것만 본다. '
      + '글자가 상자에 들어가지 않으면 잘라서 그리지 않고 text_overflow 로 거절한다 — '
      + '그때는 문안을 줄여 다시 부른다. 같은 card_no 로 다시 부르면 그 카드만 덮어쓴다. '
      + '표지(kind "cover")의 삽화는 agy 로 미리 만들어 둔 것이 있으면 그것을 쓰고, '
      + '없으면 로컬 SVG 로 그린다. 어느 쪽인지는 결과의 cover_source 로 밝힌다. '
      + 'cover 가 아닌 카드는 category 가 필수다 (fix_now=지금 손봐야 할 것 · watch=지켜볼 것 · fyi=알아둘 것). '
      + '카드 색은 category 로 정해진다. 빠지면 category_required, '
      + '제목·본문에 적은 분류 이름이 category 와 다르면 category_text_mismatch 로 거절한다.',
    inputSchema: z.object({ ...baseInput,
      card_no: z.number().int().min(1).max(12).describe('카드 순서. 1부터'),
      kind: z.enum(['cover', 'metric', 'text']).describe('cover 는 표지, metric 은 차트가 있는 지표 카드'),
      title: z.string().min(1).describe('제목. 표지는 3줄, 나머지는 3줄까지'),
      body: z.array(z.string()).default([]).describe('본문 줄들. 차트가 있으면 5줄, 없으면 12줄까지'),
      sources: z.array(z.string()).min(1)
        .describe('근거. 예: "get_system_health · summary (배포 2건)". 비울 수 없다'),
      chart_path: z.string().optional()
        .describe('render_chart 가 돌려준 svg_path. 이 실행에서 실제로 만든 것이어야 한다'),
      category: z.enum(CARD_CATEGORIES).optional()
        .describe('cover 가 아니면 필수. fix_now=지금 손봐야 할 것 · watch=지켜볼 것 · fyi=알아둘 것. 카드 색은 이 값으로 정해진다'),
    }),
    handler: ({ run_id, card_no, kind, title, body = [], sources, chart_path, category }) => {
      openRun(run_id);

      // 분류는 가장 먼저 본다. 색(accent)을 모델이 따로 고르게 두었더니 본문에는
      // 「지금 손봐야 할 것」이라 적고 색은 노랑으로 고른 카드가 나왔다 — 발행 게이트가
      // 그 카드를 못 보고 지나갔다 (DECISIONS.md D40). 분류 하나에서 색이 나오게 한다.
      const cat = kind === 'cover' ? undefined : checkCategory(category, title, body);
      const accent = cat ? CATEGORY_ACCENT[cat] : 'accent';

      // 차트는 **이 실행이 만든 것**만 받는다. 임의 경로를 읽어 카드에 넣지 못한다.
      // 경로 검사가 근거 대조보다 먼저다 — 통과하지 못한 입력의 파일부터 가린다.
      let absChart: string | undefined;
      if (chart_path) {
        if (!/^charts\/\d+\.svg$/.test(chart_path)) {
          throw new ToolError('chart_path_not_allowed',
            'chart_path 는 render_chart 가 돌려준 charts/NN.svg 형태여야 한다', { chart_path });
        }
        absChart = runPath(run_id, chart_path);
        if (!existsSync(absChart)) {
          throw new ToolError('chart_not_found',
            '그 차트 파일이 이 실행에 없다. 먼저 render_chart 로 만든다',
            { chart_path, made_in_this_run: listChartFiles(run_id) });
        }
      }

      // 근거 대조는 그 다음이다. cover 는 요약 성격이라 빈 것만 보고, 나머지는 각 행을 대조한다.
      // 통과하지 못하면 파일을 만들지 않는다.
      const sourcesVerified = kind === 'cover'
        ? null
        : sources.map((row) => verifySourceRow(run_id, row));

      // 표지 제목은 고정문으로 정규화한다. 모델이 뭘 넘기든 기록·근거표에 같은 값이 남는다.
      // 표지가 아닌 제목은 배열 문자열(`["a", "b"]`)을 풀어 기호째 그려지지 않게 한다.
      const effectiveTitle = kind === 'cover' ? COVER_TITLE : normalizeTitle(title);
      const spec: CardSpec = {
        card_no, kind, title: effectiveTitle, body, sources, chart_path, accent, ...(cat ? { category: cat } : {}),
      };
      const composed = composeCard(spec, absChart);

      const rel = `cards/${String(card_no).padStart(2, '0')}`;
      const svgAbs = runPath(run_id, `${rel}.svg`);
      const { bytes, rendered_ok } = writeSvg(svgAbs, composed.svg);
      if (!rendered_ok) {
        throw new ToolError('render_failed', '카드 SVG 가 유효한 파일로 열리지 않는다',
          { card_no, bytes });
      }
      // 텍스트를 데이터로도 남긴다. 한 장만 고칠 때 이 파일만 바뀐다.
      mkdirSync(dirname(runPath(run_id, `${rel}.json`)), { recursive: true });
      writeFileSync(runPath(run_id, `${rel}.json`),
        JSON.stringify({ ...spec, layers: composed.layers }, null, 2));

      return {
        card_no, svg_path: `${rel}.svg`, json_path: `${rel}.json`, bytes, rendered_ok,
        layers: {
          title_lines: composed.layers.title.length,
          body_lines: composed.layers.body.length,
          source_lines: composed.layers.source.length,
        },
        chart_embedded: composed.chart_embedded,
        // 각 근거 행이 이번 실행의 실제 호출·값을 가리키는지 대조했는지.
        // cover 는 대조하지 않아 null 이다.
        sources_verified: sourcesVerified,
        // 표지 삽화가 어디서 왔는지 결과로 밝힌다 (agy-asset 또는 local-svg).
        // cover 가 아니면 null 이다.
        cover_source: composed.cover_source,
        // 차트를 다시 그리지 않았음을 결과로 밝힌다 (수용 기준에 그대로 대응한다).
        chart_rerendered: false,
        other_cards_untouched: listCardNumbers(run_id).filter((n) => n !== card_no),
      };
    },
  });

  // ─────────────────────────────────────────── 9. 내보내기 (PNG · ZIP · 출처)
  defineTool(server, {
    name: 'export_cardnews',
    description:
      `만든 카드들을 PNG 로 굽고 ZIP 한 개로 묶는다. 출처 기록(SOURCES.md)도 함께 넣는다. `
      + `한 편은 ${MIN_CARDS}~${MAX_CARDS}장이다 — ${MAX_CARDS}장을 넘으면 too_many_cards 로 거절한다. `
      + '카드를 새로 만들지 않는다 — compose_card 로 만든 것만 내보낸다. '
      + '변환이 끝났다는 것과 그림이 생겼다는 것은 다르므로 PNG 머리를 직접 읽어 크기를 대조하고, '
      + 'opened_ok 가 false 인 카드가 있으면 export_incomplete 로 거절한다.',
    inputSchema: z.object({ ...baseInput,
      note: z.string().optional().describe('이번 내보내기에 남길 한 줄 메모'),
    }),
    handler: ({ run_id, note }) => {
      const meta = openRun(run_id);
      // 실제 굽기와 묶기는 cards.ts 가 한다 — 화면의 「내보내기」 버튼도 같은 함수를 부른다.
      const out = exportCardnews({ runDir: runPath(run_id), runId: run_id, mode: meta.mode });
      return {
        ...out,
        note: note ?? null,
        verify_hint: `unzip -l runs/${run_id}/${out.zip_path} 로 순서와 수량을 확인한다`,
      };
    },
  });

  // ─────────────────────────────────────────────── 6. 이슈 생성 (쓰기 ⚠️)
  defineTool(server, {
    name: 'create_github_issue',
    description:
      '브리핑에서 발견한 문제를 저장소 이슈로 남긴다. 사람이 승인했을 때만 실행된다. '
      + '에이전트는 이 도구를 직접 실행하지 않는다 — 제안만 만들고 승인을 기다린다. '
      + '유효한 approval_token 없이 호출하면 approval_required 로 거절된다. '
      + '이슈 본문에는 근거가 된 도구와 값을 함께 적는다. 삭제·수정 권한은 없다.',
    requiresApproval: true,
    destructive: false,
    inputSchema: z.object({ ...baseInput,
      repo: z.string(),
      title: z.string().min(1),
      body: z.string().min(1),
      labels: z.array(z.string()).default([]),
      source: z.object({ tool: z.string(), field: z.string() })
        .describe('이 이슈의 근거가 된 도구와 값'),
      approval_token: z.string().optional()
        .describe('앱이 사람의 승인을 받은 뒤 발급한 1회용 토큰. 없으면 실행되지 않는다'),
    }),
    handler: async ({ run_id, repo, title, body, labels, source, approval_token }) => {
      if (!config.allowedRepos.includes(repo)) {
        throw new FatalToolError('repo_not_allowed', '허용 목록에 없는 저장소다', {
          repo, allowed: config.allowedRepos,
        });
      }
      const bad = labels.filter((l) => !config.allowedLabels.includes(l));
      if (bad.length) {
        throw new ToolError('label_not_allowed', '허용 목록에 없는 라벨이다. 임의 라벨을 만들지 않는다', {
          rejected: bad, allowed: config.allowedLabels,
        });
      }

      // 승인 게이트 ② — 서버가 토큰을 검사한다. 앱을 우회해도 여기서 막힌다.
      consume(run_id, approval_token, 'create_github_issue', repo);

      if (!isFixtureMode()) {
        // 사람의 승인을 받았어도 여기서 한 번 더 막는다. 승인은 "이 내용이 맞다"는
        // 확인이지 "실제 공개 저장소에 써도 된다"는 확인이 아니다. 그 둘을 분리한다.
        requireLiveWrites('create_github_issue');
        const created = await createIssue(repo, { title, body, labels });
        appendLog(run_id, {
          at: new Date().toISOString(),
          tool: 'create_github_issue',
          target: repo,
          created: { issue_number: created.number, repo },
        });
        return {
          number: created.number, repo, created: true, url: created.url,
          state: created.state, simulated: false,
          note: 'live 모드다. 실제 이슈가 만들어졌다',
          title, body_length: body.length, labels, source,
        };
      }

      // fixture 모드: 실제 저장소를 바꾸지 않는다. 번호만 부여해 승인 기록에 남긴다.
      const number = 9000 + createdIssueNumbers(run_id).length + 1;
      appendLog(run_id, {
        at: new Date().toISOString(),
        tool: 'create_github_issue',
        target: repo,
        created: { issue_number: number, repo },
      });
      return {
        number, repo, created: true,
        url: `https://github.com/${repo}/issues/${number}`,
        simulated: true,
        note: 'fixture 모드다. 실제 이슈는 만들어지지 않았다',
        title, body_length: body.length, labels, source,
      };
    },
  });

  // ─────────────────────────────────────────── 7. 되돌리기 (쓰기 ⚠️ · 확장②)
  defineTool(server, {
    name: 'revert_issue',
    description:
      '이 실행이 승인 기록으로 만든 이슈를 닫아 되돌린다. '
      + '승인 기록에 없는 이슈 번호는 거절한다 — 이 도구로는 임의의 이슈를 닫을 수 없다. '
      + '삭제는 하지 않고 닫기만 한다. 되돌리기도 사람의 승인을 지난다.',
    requiresApproval: true,
    destructive: true,
    inputSchema: z.object({ ...baseInput,
      issue_number: z.number().int().describe('이 실행에서 만든 이슈 번호만 가능하다'),
      reason: z.string().min(1).describe('왜 되돌리는지. 실행 기록에 남는다'),
      approval_token: z.string().optional(),
    }),
    handler: async ({ run_id, issue_number, reason, approval_token }) => {
      // 대상 제한이 토큰 검사보다 먼저다. 승인받아도 범위 밖은 못 닫는다.
      const allowed = createdIssueNumbers(run_id);
      if (!allowed.includes(issue_number)) {
        throw new ToolError('not_in_approval_log',
          '이 실행의 승인 기록에 없는 이슈다. 이 도구로는 임의의 이슈를 닫을 수 없다',
          { issue_number, created_in_this_run: allowed });
      }
      if (isAlreadyReverted(run_id, issue_number)) {
        return { number: issue_number, state: 'closed', reverted: true, already: true };
      }

      consume(run_id, approval_token, 'revert_issue', String(issue_number));

      if (!isFixtureMode()) {
        requireLiveWrites('revert_issue');
        // 어느 저장소의 이슈인지는 승인 기록에서 가져온다. 입력으로 받지 않는다 —
        // 받으면 승인 기록에 있는 번호로 **다른** 저장소의 이슈를 닫을 수 있다.
        const repo = repoOfCreatedIssue(run_id, issue_number);
        const closed = await closeIssue(repo, issue_number, reason);
        appendLog(run_id, {
          at: new Date().toISOString(),
          tool: 'revert_issue',
          target: String(issue_number),
          reverted: { issue_number },
        });
        return { number: closed.number, repo, state: closed.state, reverted: true,
                 reason, url: closed.url, simulated: false };
      }

      appendLog(run_id, {
        at: new Date().toISOString(),
        tool: 'revert_issue',
        target: String(issue_number),
        reverted: { issue_number },
      });
      return { number: issue_number, state: 'closed', reverted: true, reason, simulated: true };
    },
  });
}
