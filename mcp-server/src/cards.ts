/**
 * 카드 합성과 내보내기.
 *
 * 세 가지를 지킨다.
 *
 *  1. **텍스트를 레이어로 나눈다.** 제목·본문·출처가 각각 <g id="layer-*"> 로 나가고,
 *     같은 내용이 cards/NN.json 에 데이터로도 남는다. 글자를 그림에 태워 넣지 않는다 —
 *     한 장만 고칠 때 다시 그릴 것이 텍스트뿐이어야 한다.
 *
 *  2. **글자 잘림을 조용히 넘기지 않는다.** 상자에 안 들어가면 잘라서 그리는 대신
 *     text_overflow 로 거절한다. 잘린 카드가 "만들어졌다"고 보고되는 것이 더 나쁘다.
 *
 *  3. **PNG 가 실제로 열리는지 확인한다.** 변환 명령이 성공했다는 것과 그림 파일이
 *     생겼다는 것은 다르다 (opened_ok 원칙). IHDR 을 직접 읽어 크기를 대조한다.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { ToolError } from './errors.js';

export const CARD_W = 1080;
export const CARD_H = 1350;
/**
 * PNG 바이트 하한. 1080×1350 짜리가 이보다 작으면 글자가 하나도 안 그려진 것이다.
 * (빈 그림 방지 — opened_ok 판정에 쓴다.)
 */
const MIN_PNG_BYTES = 4000;
const FONT = "'Apple SD Gothic Neo','Noto Sans KR','Malgun Gothic',sans-serif";
const PAD = 84;

const THEME = {
  bg: '#0f172a', panel: '#16233c', ink: '#f8fafc', dim: '#94a3b8',
  accent: '#38bdf8', warn: '#fbbf24', bad: '#f87171',
};

export type CardKind = 'cover' | 'metric' | 'text';

/**
 * 표지 제목 고정문. 모델이 뭘 넘기든 이 한 줄로 그린다 —
 * 줄 분리 없음, 덧붙는 기호 없음. 날짜·기간은 본문에 적는다.
 */
export const COVER_TITLE = '이번 주 「이미 있어」, 운영 브리핑';
/** 표지 제목 자동 축소의 하한. 이 이하로는 줄이지 않고 이 크기에서 한 줄로 둔다. */
const COVER_TITLE_MIN_FONT = 40;

/**
 * 제목 정규화. 모델이 제목을 JSON 배열 문자열로 넘기는 경우가 있다 —
 * `["이번 주 핵심 요약", "시스템 · 사용자 · 개발"]` 같은 입력이 카드에
 * 대괄호·따옴표째 그려지는 것을 막는다. 파싱에 실패하면 원문을 그대로 둔다.
 */
export function normalizeTitle(title: string): string {
  const t = title.trim();
  if (!/^\[.*\]$/.test(t)) return title;
  try {
    const arr: unknown = JSON.parse(t);
    if (!Array.isArray(arr) || !arr.length) return title;
    const joined = arr.map((x) => String(x).trim()).filter((x) => x !== '').join(', ');
    return joined !== '' ? joined : title;
  } catch {
    return title;
  }
}

export type CardSpec = {
  card_no: number;
  kind: CardKind;
  title: string;
  body: string[];
  sources: string[];
  /** render_chart 가 만든 SVG 의 실행 폴더 기준 상대 경로. */
  chart_path?: string | undefined;
  /** 카드 색. compose_card 에서는 category 로 정해진다 — 모델이 따로 고르지 않는다. */
  accent?: 'accent' | 'warn' | 'bad' | undefined;
  /** 브리핑 분류. 표지에는 없다. 이 칸이 생기기 전에 만든 카드에도 없다. */
  category?: CardCategory | undefined;
};

// ───────────────────────────────────────────────────────────── 분류 (DECISIONS.md D40)

/** 브리핑의 세 분류. 프롬프트의 「지금 손봐야 할 것 · 지켜볼 것 · 알아둘 것」과 같은 순서다. */
export const CARD_CATEGORIES = ['fix_now', 'watch', 'fyi'] as const;
export type CardCategory = typeof CARD_CATEGORIES[number];

/** 분류에서 색이 나온다. 색을 따로 받지 않는 이유가 이것이다 — 둘이 어긋날 수 없게. */
export const CATEGORY_ACCENT: Record<CardCategory, 'bad' | 'warn' | 'accent'> = {
  fix_now: 'bad', watch: 'warn', fyi: 'accent',
};

/** 카드 글에 분류 이름을 적었다면 이것으로 알아본다. */
const CATEGORY_PHRASE: Record<CardCategory, RegExp> = {
  fix_now: /지금 ?손봐야/, watch: /지켜볼 ?것/, fyi: /알아둘 ?것/,
};

/**
 * 표지가 아닌 카드의 분류를 확인한다.
 *   - 없으면 category_required
 *   - 제목·본문에 **다른** 분류 이름이 적혀 있으면 category_text_mismatch
 *     (글로는 「지금 손봐야 할 것」, 칸은 watch — 읽는 사람과 발행 게이트가 서로 다른 카드를 본다)
 */
export function checkCategory(category: CardCategory | undefined, title: string, body: string[]): CardCategory {
  if (!category) {
    throw new ToolError('category_required',
      'cover 가 아닌 카드는 category 가 필요하다: fix_now(지금 손봐야 할 것) · watch(지켜볼 것) · fyi(알아둘 것)',
      { allowed: [...CARD_CATEGORIES] });
  }
  const text = [title, ...body].join('\n');
  const stated = CARD_CATEGORIES.filter((c) => CATEGORY_PHRASE[c].test(text));
  const others = stated.filter((c) => c !== category);
  if (others.length) {
    throw new ToolError('category_text_mismatch',
      `글에 적은 분류(${others.join(', ')})와 category(${category})가 다르다. 둘 중 하나를 맞춘다`,
      { category, stated_in_text: others });
  }
  return category;
}

// ───────────────────────────────────────────────────────────── 글자 폭과 줄바꿈

/**
 * 글자 폭을 어림한다. 한글·한자·가나는 전각(1.0em), 그 밖은 0.55em 으로 본다.
 * 정확한 측정은 폰트 메트릭이 필요하지만, 넘침을 **보수적으로** 잡는 데는 충분하다
 * (어림이 실제보다 넓게 나오므로 잘림을 놓치지 않는다).
 */
export function textWidth(s: string, fontSize: number): number {
  let em = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide = (c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xa4cf)
      || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xff00 && c <= 0xff60) || c === 0x2014 || c === 0x2013;
    em += wide ? 1.0 : 0.55;
  }
  return em * fontSize;
}

/** 상자 폭에 맞춰 줄을 나눈다. 한글은 어절이 없어도 되므로 글자 단위로도 끊는다. */
export function wrap(text: string, maxWidth: number, fontSize: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    // 공백을 유지한 채 토큰으로 나눈다 — 영문 단어를 가운데서 자르지 않기 위해서다.
    const tokens = paragraph.match(/[^\s]+\s*|\s+/g) ?? [];
    for (const tok of tokens) {
      if (textWidth(line + tok, fontSize) <= maxWidth) { line += tok; continue; }
      if (line) { lines.push(line.trimEnd()); line = ''; }
      // 토큰 하나가 한 줄보다 길면 글자 단위로 끊는다.
      let chunk = '';
      for (const ch of tok) {
        if (textWidth(chunk + ch, fontSize) > maxWidth && chunk) { lines.push(chunk); chunk = ''; }
        chunk += ch;
      }
      line = chunk;
    }
    lines.push(line.trimEnd());
  }
  return lines.filter((l, i, a) => l !== '' || i < a.length - 1);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ───────────────────────────────────────────────────────────── 레이아웃 규칙

/** 레이어별 상자. 넘치면 그리지 않고 거절한다. */
type Box = { fontSize: number; lineHeight: number; maxLines: number };

function boxes(kind: CardKind, hasChart: boolean): { title: Box; body: Box; source: Box } {
  if (kind === 'cover') {
    return {
      title:  { fontSize: 86, lineHeight: 108, maxLines: 3 },
      body:   { fontSize: 38, lineHeight: 58, maxLines: 4 },
      source: { fontSize: 24, lineHeight: 34, maxLines: 3 },
    };
  }
  return {
    title:  { fontSize: 58, lineHeight: 74, maxLines: 3 },
    body:   { fontSize: 34, lineHeight: 52, maxLines: hasChart ? 5 : 12 },
    source: { fontSize: 22, lineHeight: 32, maxLines: 4 },
  };
}

// ───────────────────────────────────────────────────────────── 표지 삽화 출처
// agy 우선, 로컬 폴백 (DECISIONS.md D23).
//
// 런타임에 agy 를 매번 부르지 않는다 — 매번 부르면 같은 카드가 매번 다른 그림이 돼
// 캡처 재현성이 깨지고, 실행마다 에이전트 호출 비용·대기가 붙는다.
// 대신 `scripts/generate-cover.mjs` 로 미리 만들어 `assets/cover.svg` 에 커밋해 두고,
// 런타임에는 그 파일이 있으면 끼워 넣고 없으면 아래 로컬 SVG 로 그린다.

export type CoverSource = 'agy-asset' | 'local-svg';

/** 표지 삽화를 어떻게 고를지. 기본 auto — 에셋이 있으면 쓰고 없으면 로컬로 그린다. */
export function coverMode(): 'auto' | 'agy' | 'local' {
  const v = (process.env.OPS_COVER_ART ?? 'auto').trim();
  if (v === 'agy' || v === 'local' || v === 'auto') return v;
  throw new ToolError('invalid_cover_mode',
    `OPS_COVER_ART 는 auto·agy·local 중 하나여야 한다 (받은 값: ${v})`, { value: v });
}

function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === 'already-got-it-ops-mcp') return dir;
    } catch { /* 위로 계속 올라간다 */ }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

/** agy 로 미리 만들어 커밋한 표지 삽화 경로. `OPS_COVER_ASSET` 으로 바꿀 수 있다 (검사용). */
export function coverAssetPath(): string {
  const override = process.env.OPS_COVER_ASSET?.trim();
  if (override) return override;
  return join(packageRoot(), 'assets', 'cover.svg');
}

/**
 * 에셋 파일을 읽어 돌려준다. 없거나 비어 있으면 null — 호출자가 로컬로 폴백한다.
 * 있는데 깨졌으면 null 이 아니라 거절한다. 커밋된 파일이 깨진 것을 조용히 뭉개면
 * "agy 삽화를 쓴다"는 보고가 거짓이 된다.
 */
function readCoverAsset(): string | null {
  const p = coverAssetPath();
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  if (!raw.trim()) return null;
  if (raw.length > 1024 * 1024) {
    throw new ToolError('cover_not_svg', '표지 에셋이 너무 크다 (1MB 초과)', { path: p });
  }
  return raw;
}

// ───────────────────────────────────────────────────────────── 표지 삽화 (로컬)

/**
 * 표지 삽화. 런타임 이미지 생성 API 를 부르지 않고 로컬에서 그린다 (DECISIONS.md D11).
 * 「이미 있어」의 재고 격자를 모티프로, 채워진 칸과 빈 칸을 섞는다.
 * card_no 를 종자로 써서 같은 카드는 항상 같은 그림이 나온다 — 캡처가 재현된다.
 */
function coverArt(seed: number, top: number, bottom: number): string {
  let s = (seed * 2654435761) % 2147483647;
  const rnd = () => { s = (s * 48271) % 2147483647; return s / 2147483647; };

  // 격자를 주어진 상자 안에 **맞춰 계산한다.** 처음에는 칸 크기를 고정해 두었더니
  // 마지막 줄이 카드 밖으로 나가 출처 글자를 덮었다 (PNG 를 열어 보고 발견했다).
  // 클리핑도 함께 걸어 둔다 — 계산이 틀려도 카드 밖으로는 나가지 못하게.
  const cols = 6;
  const gap = 20;
  const avail = bottom - top;
  const cell = Math.min(112, Math.floor((CARD_W - PAD * 2 - (cols - 1) * gap) / cols));
  const rows = Math.max(1, Math.floor((avail + gap) / (cell + gap)));
  const gw = cols * cell + (cols - 1) * gap;
  const x0 = Math.round((CARD_W - gw) / 2);
  const y0 = top;
  const out: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const v = rnd();
      const x = x0 + c * (cell + gap);
      const y = y0 + r * (cell + gap);
      if (v < 0.42) {
        out.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="26"`
          + ` fill="${THEME.accent}" opacity="${(0.18 + v).toFixed(2)}"/>`);
      } else if (v < 0.62) {
        out.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="26"`
          + ` fill="none" stroke="${THEME.accent}" stroke-width="3" opacity="0.55"/>`);
      } else {
        out.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="26"`
          + ` fill="${THEME.panel}" opacity="0.9"/>`);
      }
    }
  }
  const gh = rows * cell + (rows - 1) * gap;
  return `<clipPath id="cover-clip"><rect x="0" y="${top}" width="${CARD_W}" height="${gh}"/></clipPath>`
    + `<g clip-path="url(#cover-clip)">${out.join('')}</g>`;
}

// ───────────────────────────────────────────────────────────── 차트 끼워 넣기

/**
 * render_chart 가 만든 SVG 를 카드 안에 **중첩 svg** 로 넣는다.
 * 다시 그리지 않고 파일을 그대로 읽는다 — 텍스트만 고칠 때 차트가 재렌더링되지 않는 이유다.
 */
/**
 * SVG 원문을 열어 viewBox 와 내부 마크업을 꺼낸다.
 * 다시 그리지 않고 파일을 그대로 읽어 끼워 넣기 위한 공통부다.
 */
function parseSvgMarkup(raw: string, notSvgCode: string, message: string, pathLabel: string): {
  vw: number; vh: number; inner: string;
} {
  const open = /<svg\b[^>]*>/.exec(raw);
  if (!open || !raw.includes('</svg>')) {
    throw new ToolError(notSvgCode, message, { path: pathLabel });
  }
  if (/<script[\s>]/i.test(raw)) {
    throw new ToolError(notSvgCode, 'script 가 든 SVG 는 카드에 넣지 않는다', { path: pathLabel });
  }
  const vb = /viewBox="([\d.\s-]+)"/.exec(open[0]);
  const [, , vw, vh] = (vb?.[1] ?? '0 0 960 540').trim().split(/\s+/).map(Number) as number[];
  const inner = raw.slice(open.index + open[0].length, raw.lastIndexOf('</svg>'));
  return { vw: vw || 960, vh: vh || 540, inner };
}

/**
 * agy 산출물을 표지 상자에 맞춘다. 차트와 같은 중첩 svg 방식 — 다시 그리지 않는다.
 * 상자보다 길면 클리핑으로 자른다. 잘라서 그리는 것이 아니라 **삽화는 잘라도 되는 영역**이라
 * 텍스트와 다르다 — 글자는 잘리면 의미가 바뀌지만 삽화는 장식이다.
 */
function embedCoverAsset(raw: string, top: number, bottom: number): string {
  const { vw, vh, inner } = parseSvgMarkup(raw, 'cover_not_svg', '표지 에셋이 SVG 로 읽히지 않는다', coverAssetPath());
  const w = CARD_W - PAD * 2;
  const h = Math.round((w * vh) / vw);
  const gh = Math.max(1, bottom - top);
  return `<clipPath id="cover-clip"><rect x="0" y="${top}" width="${CARD_W}" height="${gh}"/></clipPath>`
    + `<g clip-path="url(#cover-clip)">`
    + `<svg x="${PAD}" y="${top}" width="${w}" height="${h}"`
    + ` viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="xMidYMid slice">${inner}</svg></g>`;
}

function embedChart(absChartPath: string, x: number, y: number, w: number): {
  markup: string; height: number;
} {
  const raw = readFileSync(absChartPath, 'utf8');
  const { vw, vh, inner } = parseSvgMarkup(raw, 'chart_not_svg', '차트 파일이 SVG 로 읽히지 않는다', absChartPath);
  const h = Math.round((w * vh) / vw);
  return {
    markup: `<svg x="${x}" y="${y}" width="${w}" height="${h}"`
      + ` viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`,
    height: h,
  };
}

// ───────────────────────────────────────────────────────────── 카드 합성

export type ComposedCard = {
  svg: string;
  layers: { title: string[]; body: string[]; source: string[] };
  chart_embedded: boolean;
  /** 표지 삽화 출처. cover 가 아니면 null. */
  cover_source: CoverSource | null;
};

export function composeCard(spec: CardSpec, absChartPath?: string): ComposedCard {
  const hasChart = Boolean(absChartPath);
  const b = boxes(spec.kind, hasChart);
  const inner = CARD_W - PAD * 2;
  const accent = THEME[spec.accent ?? 'accent'];

  const titleLines = spec.kind === 'cover'
    ? [COVER_TITLE]
    : wrap(spec.title, inner, b.title.fontSize);
  // 표지는 글자 크기를 줄여서라도 한 줄에 넣는다. 줄을 나누면 고정문이 깨진다.
  let titleFontSize = b.title.fontSize;
  if (spec.kind === 'cover') {
    while (titleFontSize > COVER_TITLE_MIN_FONT && textWidth(COVER_TITLE, titleFontSize) > inner) {
      titleFontSize -= 2;
    }
  }
  const bodyLines = wrap(spec.body.join('\n'), inner, b.body.fontSize);
  const sourceLines = wrap(spec.sources.join('\n'), inner, b.source.fontSize);

  // 잘라서 그리지 않는다. 무엇이 얼마나 넘쳤는지 알려 주고 거절한다.
  const over = ([
    ['title', titleLines, b.title.maxLines],
    ['body', bodyLines, b.body.maxLines],
    ['sources', sourceLines, b.source.maxLines],
  ] as const).filter(([, lines, max]) => lines.length > max);

  if (over.length) {
    throw new ToolError('text_overflow',
      '카드 상자에 글자가 들어가지 않는다. 잘라서 그리지 않고 거절한다 — 문안을 줄여 다시 부른다',
      {
        card_no: spec.card_no,
        overflow: over.map(([name, lines, max]) => ({
          layer: name, lines_needed: lines.length, lines_allowed: max,
        })),
        hint: hasChart
          ? '차트가 있는 카드는 본문 5줄까지다. 차트를 빼면 12줄까지 쓸 수 있다'
          : '본문은 12줄까지다',
      });
  }

  const parts: string[] = [];

  // 출처 띠가 시작하는 높이. 삽화는 이 위에서 끝나야 한다.
  const sourceTop = CARD_H - PAD - sourceLines.length * b.source.lineHeight;
  const artBottom = sourceTop - 60;

  // ── 배경 레이어 + 표지 삽화 (agy 우선, 로컬 폴백)
  let coverSource: CoverSource | null = null;
  let coverMarkup = '';
  if (spec.kind === 'cover') {
    const mode = coverMode();
    const asset = mode === 'local' ? null : readCoverAsset();
    if (asset) {
      // 깨진 에셋은 readCoverAsset 이 아니라 embedCoverAsset(parseSvgMarkup)이 거절한다.
      coverMarkup = embedCoverAsset(asset, 660, artBottom);
      coverSource = 'agy-asset';
    } else {
      if (mode === 'agy') {
        throw new ToolError('cover_asset_missing',
          'OPS_COVER_ART=agy 지만 표지 에셋이 없다. scripts/generate-cover.mjs 로 먼저 만든다',
          { expected: coverAssetPath(), hint: 'npm run generate-cover' });
      }
      coverMarkup = coverArt(spec.card_no, 660, artBottom);
      coverSource = 'local-svg';
    }
  }
  parts.push(`<g id="layer-background">`
    + `<rect width="${CARD_W}" height="${CARD_H}" fill="${THEME.bg}"/>`
    + `<rect x="0" y="0" width="${CARD_W}" height="10" fill="${accent}"/>`
    + coverMarkup
    + `</g>`);

  let y = spec.kind === 'cover' ? 300 : PAD + titleFontSize + 60;

  // 카드 번호는 배경 레이어에 붙는 장식이 아니라 별도로 둔다 — 순서 점검에 쓴다.
  parts.push(`<g id="layer-index">`
    + `<text x="${PAD}" y="${PAD + 26}" font-family="${FONT}" font-size="26"`
    + ` fill="${THEME.dim}" letter-spacing="4">CARD ${String(spec.card_no).padStart(2, '0')}</text>`
    + `</g>`);

  // ── 제목 레이어
  const titleY = y;
  parts.push(`<g id="layer-title" data-lines="${titleLines.length}">`
    + titleLines.map((l, i) => `<text x="${PAD}" y="${titleY + i * b.title.lineHeight}"`
      + ` font-family="${FONT}" font-size="${titleFontSize}" font-weight="700"`
      + ` fill="${THEME.ink}">${esc(l)}</text>`).join('')
    + `</g>`);
  y = titleY + titleLines.length * b.title.lineHeight + 28;

  // ── 차트 레이어 (읽어서 끼워 넣는다. 다시 그리지 않는다)
  let chartEmbedded = false;
  if (absChartPath) {
    const { markup, height } = embedChart(absChartPath, PAD, y, inner);
    parts.push(`<g id="layer-chart" data-source-file="${esc(basename(absChartPath))}">`
      + `<rect x="${PAD - 16}" y="${y - 16}" width="${inner + 32}" height="${height + 32}"`
      + ` rx="20" fill="${THEME.panel}"/>${markup}</g>`);
    // 기준선(baseline)이므로 글자 높이만큼 더 내린다. 44 만 두었을 때는
    // 본문 첫 줄이 차트 패널에 붙어 보였다.
    y += height + 44 + b.body.fontSize;
    chartEmbedded = true;
  }

  // ── 본문 레이어
  parts.push(`<g id="layer-body" data-lines="${bodyLines.length}">`
    + bodyLines.map((l, i) => `<text x="${PAD}" y="${y + i * b.body.lineHeight}"`
      + ` font-family="${FONT}" font-size="${b.body.fontSize}"`
      + ` fill="${THEME.dim}">${esc(l)}</text>`).join('')
    + `</g>`);

  // ── 출처 레이어 (항상 카드 아래쪽에 고정한다)
  const srcTop = sourceTop;
  parts.push(`<g id="layer-source" data-lines="${sourceLines.length}">`
    + `<line x1="${PAD}" y1="${srcTop - 30}" x2="${CARD_W - PAD}" y2="${srcTop - 30}"`
    + ` stroke="${THEME.panel}" stroke-width="2"/>`
    + sourceLines.map((l, i) => `<text x="${PAD}" y="${srcTop + i * b.source.lineHeight}"`
      + ` font-family="${FONT}" font-size="${b.source.fontSize}"`
      + ` fill="${THEME.dim}">${esc(l)}</text>`).join('')
    + `</g>`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_W} ${CARD_H}"`
    + ` width="${CARD_W}" height="${CARD_H}" role="img">`
    + `<title>${esc(titleLines.join(' / '))}</title>${parts.join('')}</svg>`;

  return {
    svg,
    layers: { title: titleLines, body: bodyLines, source: sourceLines },
    chart_embedded: chartEmbedded,
    cover_source: coverSource,
  };
}

// ───────────────────────────────────────────────────────────── 래스터화

/** Chrome 실행 경로. 없으면 무엇을 하면 되는지 알린다. */
function chromePath(): string {
  const fromEnv = process.env.OPS_CHROME_PATH?.trim();
  const candidates = [
    ...(fromEnv ? [fromEnv] : []),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new ToolError('rasterizer_not_found',
      'SVG 를 PNG 로 바꿀 브라우저를 찾지 못했다. OPS_CHROME_PATH 로 경로를 지정한다',
      { looked_in: candidates });
  }
  return found;
}

/** PNG 의 IHDR 에서 실제 크기를 읽는다. 변환 성공 보고를 믿지 않는다. */
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) {
    throw new ToolError('png_invalid', '만들어진 파일이 PNG 가 아니다', { path, bytes: buf.length });
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function rasterize(svgAbs: string, pngAbs: string): {
  bytes: number; width: number; height: number; opened_ok: boolean;
} {
  mkdirSync(dirname(pngAbs), { recursive: true });
  try {
    execFileSync(chromePath(), [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--force-device-scale-factor=1', `--window-size=${CARD_W},${CARD_H}`,
      `--screenshot=${pngAbs}`, `file://${svgAbs}`,
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60_000 });
  } catch (err) {
    // 변환 명령 자체가 실패하면 일반 Error 가 올라간다. opened_ok 원칙대로 코드화한다.
    const timedOut = (err as { code?: string })?.code === 'ETIMEDOUT';
    throw new ToolError(timedOut ? 'render_timeout' : 'render_failed',
      timedOut ? '브라우저 변환이 60초 안에 끝나지 않았다' : '브라우저 변환 명령이 실패했다',
      { path: pngAbs, detail: err instanceof Error ? err.message.slice(0, 300) : String(err) });
  }

  if (!existsSync(pngAbs)) {
    throw new ToolError('render_failed', '변환 명령은 끝났지만 PNG 파일이 없다', { path: pngAbs });
  }
  const bytes = statSync(pngAbs).size;
  const { width, height } = pngSize(pngAbs);
  const opened_ok = bytes > MIN_PNG_BYTES && width === CARD_W && height === CARD_H;
  return { bytes, width, height, opened_ok };
}

// ───────────────────────────────────────────────────────────── ZIP (의존성 없이)

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * ZIP 을 직접 쓴다. 외부 명령이나 패키지에 의존하지 않으려는 것도 있지만,
 * 더 큰 이유는 검증을 **독립된 도구**(unzip)로 하고 싶어서다.
 * 만드는 쪽과 확인하는 쪽이 같은 코드면 잘못 만든 ZIP 을 잘못 확인한다.
 */
export function writeZip(outPath: string, entries: Array<{ name: string; data: Buffer }>): number {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  // DOS 형식 날짜·시각. 넣지 않으면 1980-00-00 으로 남는다.
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const deflated = deflateRawSync(e.data);
    // 압축이 손해면 그냥 저장한다 (PNG 는 이미 압축돼 있다).
    const useDeflate = deflated.length < e.data.length;
    const payload = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);        // 파일명이 UTF-8 임을 알린다 (한글 이름 대비)
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += 30 + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  const zip = Buffer.concat([...locals, centralBuf, end]);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, zip);
  return zip.length;
}

// ───────────────────────────────────────────────────────────── 출처 기록

export function sourcesMarkdown(runId: string, cards: CardSpec[], mode: string): string {
  const lines = [
    `# 카드뉴스 출처 기록`,
    ``,
    `실행 \`${runId}\` · 모드 \`${mode}\` · 생성 ${new Date().toISOString()}`,
    ``,
    `카드에 적힌 수치는 모두 아래 도구 호출에서 왔다.`,
    `\`render_chart\` 는 근거 대조를 통과하지 못한 값으로는 차트를 그리지 않고,`,
    `\`compose_card\` 는 출처가 비어 있는 카드를 만들지 않는다.`,
    ``,
    `| 카드 | 제목 | 차트 | 출처 |`,
    `|---|---|---|---|`,
  ];
  // 표 셀에는 줄바꿈을 넣을 수 없다. 파이프도 이스케이프한다.
  // (실제 실행에서 모델이 제목을 3줄로 줘서 표가 무너졌다 — SOURCES.md 를 열어 보고 발견했다.)
  const cell = (v: string) => v.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  for (const c of cards) {
    lines.push(`| ${String(c.card_no).padStart(2, '0')} | ${cell(c.title)} `
      + `| ${c.chart_path ?? '—'} | ${c.sources.map(cell).join('<br>')} |`);
  }
  lines.push('', '## 확인 방법', '',
    '```bash', 'unzip -l cardnews-<run>.zip     # 순서와 수량',
    'unzip -t cardnews-<run>.zip     # 파일이 온전한가', '```', '');
  return lines.join('\n');
}

/** 실행 폴더의 카드 명세를 번호 순으로 읽는다. */
export function readCardSpecs(cardsDir: string): CardSpec[] {
  if (!existsSync(cardsDir)) return [];
  return readdirSync(cardsDir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(cardsDir, f), 'utf8')) as CardSpec;
      } catch {
        throw new ToolError('card_spec_corrupted',
          `카드 명세 파일이 깨졌다: ${f}. 수선하지 않고 그대로 둔다`,
          { file: f });
      }
    });
}


// ───────────────────────────────────────────────────────────── 내보내기

/** 카드뉴스 한 편의 길이 (PRD 1절). 도구와 화면이 같은 값을 봐야 한다. */
export const MIN_CARDS = 5;
export const MAX_CARDS = 8;

export type ExportResult = {
  zip_path: string;
  zip_bytes: number;
  cards: number;
  card_count_note?: string;
  entries: string[];
  png: { card_no: number; file: string; bytes: number; width: number; height: number; opened_ok: boolean }[];
  sources_path: string;
  opened_ok: true;
};

/**
 * 카드를 PNG 로 굽고 ZIP 한 개로 묶는다.
 *
 * **도구(export_cardnews)와 화면의 「내보내기」 버튼이 같은 이 함수를 부른다.**
 * 두 곳에 따로 구현하면 한쪽만 고쳐지고, 사람이 만든 것과 에이전트가 만든 것이 달라진다.
 *
 * 경로는 runDir 로 받는다 — config.runsDir 에 기대면 앱(cwd 가 app/)에서 엉뚱한 곳을 본다.
 */
export function exportCardnews(opts: { runDir: string; runId: string; mode: string }): ExportResult {
  const { runDir, runId, mode } = opts;
  const at = (...parts: string[]) => join(runDir, ...parts);

  const specs = readCardSpecs(at('cards'));
  if (!specs.length) {
    throw new ToolError('no_cards', '내보낼 카드가 없다. 먼저 compose_card 로 만든다', {});
  }

  // 번호가 1부터 빠짐없이 이어지는지 본다. 순서는 ZIP 파일명으로 고정된다.
  const numbers = specs.map((c) => c.card_no).sort((a, b) => a - b);
  if (numbers.some((n, i) => n !== i + 1)) {
    throw new ToolError('card_numbers_not_contiguous',
      '카드 번호가 1부터 이어지지 않는다. 빠진 번호를 만들거나 번호를 다시 매긴다',
      { found: numbers });
  }

  // 한 편은 5~8장이다 (PRD 1절).
  // **위쪽만 막는다.** 너무 긴 카드뉴스는 결함이지만 너무 짧은 것은 결함이 아닐 수 있다 —
  // 프롬프트가 "자료가 부족하면 카드 수를 채우려 하지 말라"고 지시하기 때문이다.
  if (specs.length > MAX_CARDS) {
    throw new ToolError('too_many_cards',
      `한 편은 ${MAX_CARDS}장까지다. 덜 중요한 카드를 합치거나 뺀 뒤 다시 내보낸다`,
      { count: specs.length, allowed: MAX_CARDS });
  }
  const short = specs.length < MIN_CARDS
    ? `카드가 ${specs.length}장이다 (보통 ${MIN_CARDS}~${MAX_CARDS}장).`
      + ' 자료가 부족해서라면 그대로 두고, 무엇이 부족한지 브리핑에 적는다'
    : null;

  const rendered = specs.map((c) => {
    const nn = String(c.card_no).padStart(2, '0');
    const r = rasterize(at('cards', `${nn}.svg`), at('png', `${nn}.png`));
    return { card_no: c.card_no, file: `${nn}.png`, ...r };
  });

  const failed = rendered.filter((r) => !r.opened_ok);
  if (failed.length) {
    throw new ToolError('export_incomplete',
      'PNG 로 열리지 않는 카드가 있다. ZIP 을 만들지 않는다',
      { failed, expected_size: `${CARD_W}x${CARD_H}` });
  }

  const sources = sourcesMarkdown(runId, specs, mode);
  writeFileSync(at('SOURCES.md'), sources);

  const zipName = `cardnews-${runId}.zip`;
  const zipBytes = writeZip(at(zipName), [
    ...rendered.map((r) => ({ name: `cards/${r.file}`, data: readFileSync(at('png', r.file)) })),
    { name: 'SOURCES.md', data: Buffer.from(sources, 'utf8') },
  ]);

  return {
    zip_path: zipName,
    zip_bytes: zipBytes,
    cards: rendered.length,
    ...(short ? { card_count_note: short } : {}),
    entries: [...rendered.map((r) => `cards/${r.file}`), 'SOURCES.md'],
    png: rendered,
    sources_path: 'SOURCES.md',
    opened_ok: true,
  };
}
