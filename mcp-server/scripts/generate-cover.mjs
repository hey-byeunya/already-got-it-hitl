#!/usr/bin/env node
/**
 * 표지 삽화를 agy 로 미리 만들어 mcp-server/assets/cover.svg 에 저장한다 (DECISIONS.md D23).
 *
 * 왜 미리 만드는가 — 런타임에 agy 를 매번 부르면 같은 카드가 매번 다른 그림이 돼
 * 캡처 재현성이 깨지고, 실행마다 에이전트 호출 비용·대기가 붙는다 (D11).
 * 그래서 생성은 사람이 한 번, 사용은 매 실행이다.
 *
 *   npm run generate-cover            # agy 로 생성 → assets/cover.svg 저장
 *   OPS_AGY_BIN=/path/to/agy npm run generate-cover
 *
 * agy 가 없으면 만들지 않고 로컬 폴백을 안내한다 — 없는 명령을 가정하지 않는다.
 * 저장된 파일은 compose_card 가 표지(kind "cover")에 그대로 끼워 넣는다.
 * 없으면 로컬 SVG 로 그린다 (OPS_COVER_ART=auto 기본값).
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'assets', 'cover.svg');

const PROMPT = `다음 조건을 만족하는 SVG 코드 하나만 출력하라. 설명·마크다운 펜스 없이 <svg> 로 시작해 </svg> 로 끝낸다.

- 용도: 주간 운영 브리핑 카드뉴스 표지(1080×1350)의 삽화 영역. 카드 배경은 짙은 남색(#0f172a)이다.
- viewBox="0 0 912 400", width="912" height="400".
- 주제: 재고 격자 — 채워진 칸과 빈 칸이 섞인 둥근 사각형 격자. 「이미 있어」 앱의 모티프다.
- 색: 주 강조 #38bdf8, 보조 패널 #16233c, 옅은 회색 #94a3b8. 배경은 투명으로 둔다 (카드 배경이 비친다).
- 금지: 텍스트·문자·<script>·외부 이미지 참조·애니메이션. 장식용 도형만.
- 같은 입력에 항상 같은 그림이 나오도록 난수 없이 고정된 배치를 쓴다.`;

function findAgy() {
  const override = process.env.OPS_AGY_BIN?.trim();
  if (override) {
    if (!existsSync(override)) {
      console.error(`OPS_AGY_BIN 에 지정한 agy 가 없다: ${override}`);
      process.exit(2);
    }
    return override;
  }
  try {
    const found = execSync('command -v agy', { encoding: 'utf8' }).trim().split('\n')[0]?.trim();
    return found || null;
  } catch {
    return null;
  }
}

function main() {
  const agy = findAgy();
  if (!agy) {
    console.error('agy 를 찾지 못했다 — 표지 삽화를 만들지 않는다.');
    console.error('로컬 SVG 폴백이 그대로 쓰인다. agy 를 설치한 뒤 다시 실행한다.');
    console.error('(특정 경로를 쓰려면 OPS_AGY_BIN=/path/to/agy)');
    process.exit(2);
  }

  let out;
  try {
    out = execFileSync(agy, ['-p', PROMPT], {
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`agy 호출이 실패했다: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const m = out.match(/<svg[\s\S]*<\/svg>/);
  if (!m) {
    console.error('agy 출력에서 <svg>…</svg> 를 찾지 못했다. 원인을 보고 다시 실행한다.');
    console.error('--- agy 출력 앞부분 ---');
    console.error(out.slice(0, 1000));
    process.exit(1);
  }
  const svg = m[0];
  if (/<script[\s>]/i.test(svg)) {
    console.error('생성된 SVG 에 <script> 가 들어 있어 저장하지 않는다.');
    process.exit(1);
  }
  if (svg.length > 200 * 1024) {
    console.error(`생성된 SVG 가 너무 크다 (${svg.length} 바이트, 상한 200KB). 저장하지 않는다.`);
    process.exit(1);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${svg}\n`, 'utf8');
  console.log(`표지 삽화를 저장했다: ${OUT} (${svg.length} 바이트)`);
  console.log('다음: git 에 커밋하고, npm run check 로 카드 검사가 통과하는지 확인한다.');
}

main();
