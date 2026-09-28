/**
 * SVG 차트 렌더링과 근거 대조.
 *
 * 이 도구의 핵심은 그림이 아니라 **근거 검사**다.
 * render_chart 는 source 가 가리키는 도구 호출이 이 실행의 기록에 실제로 있고,
 * data 의 값이 그 결과에 실제로 있는지 대조한다. 어긋나면 그리지 않는다.
 *
 * 막으려는 것: 모델이 기억이나 추측으로 만든 수치가 차트로 그려져 사실처럼 보이는 일.
 * (EVAL.md 의 환각률과 직접 이어진다.)
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { ToolError } from './errors.js';
import { lastSuccessfulOutput } from './runlog.js';

export type ChartPoint = { label: string; value: number };
export type Source = { tool: string; field: string; run_step?: number };

/**
 * `series[].signups` · `totals.signups` · `deployments[0].state` 같은 경로를 푼다.
 * `[]` 는 배열 전체를 순회한다.
 */
export function resolveField(root: unknown, field: string): unknown[] {
  const parts = field.split('.');
  let current: unknown[] = [root];

  for (const rawPart of parts) {
    // 키 문자에 유니코드를 허용한다. 그래야 **모르는 키**(→ 빈 결과 → source_field_empty)와
    // **잘못된 형식**(→ invalid_source_field)이 구별된다. 둘을 같은 오류로 묶으면
    // "경로를 잘못 썼다"와 "그 값이 자료에 없다"를 진단할 수 없다.
    const m = /^([\p{L}\p{N}_]+)(\[(\d*)\])?$/u.exec(rawPart);
    if (!m) throw new ToolError('invalid_source_field', `source.field 형식을 해석할 수 없다: ${field}`, { part: rawPart });
    const [, key, bracket, index] = m;

    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || typeof node !== 'object') continue;
      const v = (node as Record<string, unknown>)[key!];
      if (v === undefined) continue;
      if (bracket === undefined) {
        next.push(v);
      } else if (Array.isArray(v)) {
        if (index === '') next.push(...v);
        else {
          const i = Number(index);
          if (i < v.length) next.push(v[i]);
        }
      }
    }
    current = next;
  }
  return current;
}

/**
 * 해석된 노드들에서 숫자를 모은다.
 *
 * 객체가 나오면 그 안의 숫자 값도 모은다 — `totals` 처럼 여러 지표를 한 카드에
 * 막대 셋으로 그리는 것은 정당한 요구다. (첫 실제 실행에서 이걸 거절했다.)
 * 범위는 여전히 **그 도구가 실제로 돌려준 값** 안이라, 지어낸 수치는 그대로 막힌다.
 */
function numbersIn(nodes: unknown[]): number[] {
  const out: number[] = [];
  for (const n of nodes) {
    if (typeof n === 'number' && Number.isFinite(n)) {
      out.push(n);
    } else if (n !== null && typeof n === 'object' && !Array.isArray(n)) {
      for (const v of Object.values(n as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
      }
    }
  }
  return out;
}

/**
 * 도구 이름을 실행 기록의 형식으로 맞춘다.
 *
 * 모델은 자기가 부르는 이름(`mcp__<서버>__get_x`)을 source.tool 에 넣지만,
 * 실행 기록은 MCP 서버가 자기 이름(`get_x`)으로 남긴다. 이 차이를 서버가 흡수한다.
 * (첫 실제 실행에서 source_not_found 가 다섯 번 나고, 모델이 시행착오로 알아냈다.
 *  형식을 맞추는 일은 모델이 아니라 도구가 해야 한다.)
 */
export function normalizeToolName(name: string): string {
  return name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/^mcp__.*?__/, '');
}

/**
 * 이번 실행에서 특정 도구가 성공적으로 돌려준 마지막 결과.
 * 기록이 없으면 도구 이름과 고치는 법을 담아 거절한다 — chart·compose 가 공유한다.
 */
export function resolveSourceOutput(runId: string, tool: string, source: unknown): unknown {
  const toolKey = normalizeToolName(tool);
  const output = lastSuccessfulOutput(runId, toolKey);
  if (output === undefined) {
    throw new ToolError(
      'source_not_found',
      `이 실행에서 ${toolKey} 을 성공적으로 호출한 기록이 없다. 근거 없이는 만들지 않는다`,
      { source, resolved_tool: toolKey, how_to_fix: `먼저 ${toolKey} 을 호출한다` },
    );
  }
  return output;
}

/**
 * `compose_card` sources 한 행을 대조한다. `"도구 · 필드"` 형식이어야 한다.
 *
 * 필드 뒤 괄호 메모(`"get_user_metrics · totals (가입 14)"`)는 허용한다 —
 * 파서는 `·` 뒤 첫 토큰까지만 필드로 읽는다. 존재 여부까지만 본다.
 * 값이 문장 내용과 의미상 이어지는지는 사람이 본다 (EVAL 근거 미표기율).
 */
export function verifySourceRow(runId: string, row: string): { tool: string; field: string } {
  const sep = row.indexOf('·');
  const tool = (sep < 0 ? '' : row.slice(0, sep)).trim();
  const rest = (sep < 0 ? '' : row.slice(sep + 1)).trim();
  // 필드는 첫 토큰까지. 뒤에 붙는 "(가입 14)" 같은 메모는 사람이 읽을 설명이다.
  const field = rest.split(/[\s(]/, 1)[0]?.trim() ?? '';
  if (!tool || !field) {
    throw new ToolError('source_shape_invalid',
      '근거는 "도구 · 필드" 형식이어야 한다. 예: "get_user_metrics · totals.active_users"',
      { row, how_to_fix: '어느 도구의 어느 값인지 "·" 로 이어 적는다' });
  }

  const source = { tool, field };
  const output = resolveSourceOutput(runId, tool, source);
  const resolved = resolveField(output, field)
    .filter((v) => v !== null && v !== undefined && v !== '');
  if (resolved.length === 0) {
    throw new ToolError('source_field_empty',
      `근거가 가리키는 값이 결과에 없다: ${tool} · ${field}`,
      { source, hint: '예: series[].signups, totals.active_users' });
  }
  return { tool: normalizeToolName(tool), field };
}
export function verifySource(runId: string, source: Source, data: ChartPoint[]): void {
  if (data.length === 0) {
    throw new ToolError('empty_chart_data', 'data 가 비어 있다. 그릴 것이 없다', { source });
  }

  const output = resolveSourceOutput(runId, source.tool, source);
  const resolved = numbersIn(resolveField(output, source.field));
  if (resolved.length === 0) {
    throw new ToolError('source_field_empty', `source.field 가 숫자를 가리키지 않는다: ${source.field}`, {
      source, hint: '예: series[].signups, totals.active_users',
    });
  }

  const allowed = new Set(resolved);
  const offenders = data.filter((p) => !allowed.has(p.value));
  if (offenders.length > 0) {
    throw new ToolError(
      'source_mismatch',
      '차트 데이터에 근거 자료에 없는 값이 있다. 지어낸 수치로는 차트를 그릴 수 없다',
      {
        source,
        offending_points: offenders,
        values_available_in_source: resolved,
      },
    );
  }
}

/** 의존성 없이 SVG 를 직접 만든다. 글자는 카드에서 별도 레이어로 얹으므로 여기엔 최소만 넣는다. */
export function renderBarChart(opts: {
  title: string;
  data: ChartPoint[];
  highlight?: { label: string; note?: string } | null;
}): string {
  const W = 960, H = 540, PAD = 72;
  // 제목이 차지하는 띠를 막대 영역에서 빼 둔다.
  // 처음에는 빼지 않아서, 가장 높은 막대의 값 라벨이 제목과 겹쳐 둘 다 읽히지 않았다
  // (카드 PNG 를 실제로 열어 보고 발견했다 — SVG 만 보고는 몰랐다).
  const TOP = PAD + 34;
  const { title, data, highlight } = opts;
  const max = Math.max(...data.map((d) => d.value), 1);
  const bw = (W - PAD * 2) / data.length;

  const bars = data.map((d, i) => {
    const h = Math.round(((H - PAD - TOP) * d.value) / max);
    const x = PAD + i * bw + bw * 0.15;
    const y = H - PAD - h;
    const on = highlight?.label === d.label;
    return [
      `<rect x="${x.toFixed(1)}" y="${y}" width="${(bw * 0.7).toFixed(1)}" height="${h}" rx="4" `
        + `fill="${on ? '#1f6feb' : '#9aa4b2'}" />`,
      `<text x="${(x + bw * 0.35).toFixed(1)}" y="${H - PAD + 22}" font-size="16" fill="#5b6472" `
        + `text-anchor="middle">${escapeXml(d.label)}</text>`,
      `<text x="${(x + bw * 0.35).toFixed(1)}" y="${y - 8}" font-size="18" `
        + `fill="${on ? '#1f6feb' : '#39414d'}" text-anchor="middle" font-weight="600">${d.value}</text>`,
    ].join('');
  }).join('');

  const note = highlight?.note
    ? `<text x="${W - PAD}" y="${PAD - 18}" font-size="16" fill="#1f6feb" text-anchor="end">`
      + `${escapeXml(highlight.note)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`
    + `<title>${escapeXml(title)}</title>`
    + `<rect width="${W}" height="${H}" fill="#ffffff"/>`
    + `<text x="${PAD}" y="${PAD - 18}" font-size="24" fill="#151b23" font-weight="700">${escapeXml(title)}</text>`
    + note
    + `<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="#d5dae1" stroke-width="2"/>`
    + bars
    + `</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/**
 * 파일로 쓰고 **실제로 열리는지** 확인한다.
 * "요청 성공"과 "결과물 생성"은 다르다 (TOOLS.md 의 opened_ok 원칙).
 */
export function writeSvg(path: string, svg: string): { bytes: number; rendered_ok: boolean } {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, svg, 'utf8');
  const bytes = statSync(path).size;
  const ok = bytes > 0 && svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>');
  return { bytes, rendered_ok: ok };
}
