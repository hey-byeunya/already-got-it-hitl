# 도메인 도구 MCP 서버

「이미 있어」 운영 브리핑 에이전트의 도구 9개를 **stdio MCP 서버**로 노출한다.
구현은 여기 한 곳뿐이고, 두 클라이언트가 같은 서버를 붙여 쓴다.

```
mcp-server/            ← 도구 9개 (구현은 여기 한 곳)
   ↑ 붙여 씀
app/  (Next.js)        ← Claude Agent SDK 의 mcpServers 옵션
Claude Code            ← 저장소 루트의 .mcp.json
```

그래서 **승인 게이트를 앱 화면이 아니라 서버 경계에 둘 수 있다.** 앱을 우회해 서버에 직접 붙어도
승인 없이는 쓰기 도구가 실행되지 않는다. 근거는 `../DECISIONS.md` D13·D14.

## 실행

```sh
npm install
npm run build
npm run verify        # 빌드 + 자체 검사 + 스모크
```

| 명령 | 하는 일 |
|---|---|
| `npm run build` | TypeScript 컴파일 |
| `npm run check` | 자체 검사 114개 (모델·네트워크 없이 돈다) |
| `npm run smoke [fixture]` | 서버에 stdio 로 붙어 도구 흐름을 한 번 돌린다 |
| `npm start` | 서버를 stdio 로 띄운다 (MCP 클라이언트가 붙을 때 쓴다) |

## 모드

| `OPS_MODE` | 하는 일 |
|---|---|
| `fixture` (기본) | 외부 API 를 부르지 않고 `../fixtures/snapshots/*.json` 을 읽는다. **쓰기 도구도 실제 GitHub 을 바꾸지 않는다** |
| `live` | 실제 API 를 부른다. `npm run smoke-live` 로 읽기 경로를 확인한다 |

기본값이 `fixture` 인 이유: 실수로 실제 저장소에 쓰는 것보다 실수로 픽스처를 읽는 편이 낫다.

## 환경변수

| 변수 | 기본값 | 용도 |
|---|---|---|
| `OPS_MODE` | `fixture` | 모드 |
| `OPS_RUNS_DIR` | `runs` | 실행 기록·승인 기록·차트가 쌓이는 곳 |
| `OPS_FIXTURES_DIR` | `../fixtures/snapshots` | 픽스처 위치 |
| `OPS_FIXTURE_ID` | (없음) | 실행에 픽스처가 지정되지 않았을 때의 기본값. **live에서는 언제나 무시된다** (`DECISIONS.md` D32 — 픽스처 누수를 읽는 자리에서 막는다) |
| `GITHUB_ALLOWED_REPOS` | `hey-byeunya/already-got-it` | **이 목록 밖 저장소는 도구가 거절한다** |
| `GITHUB_ALLOWED_LABELS` | `ops,bug,enhancement,question` | 임의 라벨을 만들지 않는다 |
| `OPS_APPROVAL_TTL` | `600` | 승인 토큰 유효 시간(초) |

값은 **읽을 때마다** 환경변수에서 가져온다. 모듈 로드 시점에 고정하면 검사끼리 상태가 새어 나간다
(실제로 그렇게 만들었다가 검사 세 개가 서로의 상태를 물려받았다).

## Claude Code 에서 붙이기

저장소 루트의 `.mcp.json` 이 이 서버를 등록한다. 빌드한 뒤 저장소를 Claude Code 로 열면 도구 9개가 뜬다.

```sh
npm run build && cd .. && claude
```

`/mcp` 로 연결 상태를 확인한다. 쓰기 도구를 승인 토큰 없이 불러 보면 서버가 거절하는 것을 볼 수 있다 —
게이트가 앱이 아니라 서버에 있다는 증거다.

## 승인 게이트 세 겹

| 겹 | 어디에 | 이 파일 |
|---|---|---|
| ① `_meta["anthropic/requiresUserInteraction"]` | 도구 정의 | `src/register.ts` |
| ② `approval_token` 검사 | 서버 실행 직전 | `src/approvals.ts` |
| ③ `PreToolUse` 훅 | 앱 (`agent/src/hook.ts`) | 설정과 무관한 불변식 2종만 검사한다 |

①은 **allow 규칙이 매치돼도 항상 승인 콜백으로 떨어지게** 만든다. Agent SDK 문서가 경고하듯
자동 승인된 도구는 `canUseTool` 에 도달하지 않으므로, 클라이언트 설정 한 줄로 게이트가 무력화될 수 있다.
①이 그걸 막고, ②가 앱 우회를 막는다.

토큰 발급은 이 서버의 일이 **아니다.** 사람의 승인을 받은 앱만 발급한다. 토큰은 `apr_` + 예측할 수 없는 난수(`node:crypto` `randomBytes`)다 (D44).
개발·검증용 발급기는 `scripts/mint-approval.mjs` 에 따로 있다.

## 자체 검사

관측된(또는 예상되는) 실패 하나당 검사 하나를 두고, **막아야 할 것과 막으면 안 되는 경계**를 짝지었다.
Day 38 하네스 `checks/` 방식이다.

| 검사 | 무엇을 막는가 | 경계 |
|---|---|---|
| `approval-gate` | 토큰 없음·재사용·만료·범위 불일치 | 유효한 승인은 통과. 실행끼리 토큰이 섞이지 않음 |
| `source-verification` | 근거 없는 수치로 차트 그리기 | 자료에 있는 값은 통과. `totals` 같은 단일 값도 통과 |
| `revert-scope` | 승인 기록에 없는 이슈 닫기 | 자기 실행이 만든 이슈는 되돌림. 두 번 되돌리지 않음(멱등) |
| `missing-vs-zero` | 결측을 0 으로 읽기 | 실제 0(배포 0건)은 0 으로. 낮은 값은 결측이 아님 |
| `tool-surface` | 쓰기 도구에 `_meta` 누락 | 읽기 도구에는 붙지 않음(매번 물으면 게이트가 무의미) |
| `cards` | 글자 잘림·출처 띠 덮음·깨진 에셋을 그냥 넘기기 · 분류 칸 누락(`category_required`) · 글과 칸의 불일치(`category_text_mismatch`) | 상자에 들어가면 통과. 에셋이 없어도 로컬 폴백으로 그린다. 표지는 분류가 필요 없다 |
| `live-mode` | live에서 픽스처 섞기·형태 어긋난 응답을 빈 정상으로 읽기 | fixture 모드 정상은 통과. `validate` 없는 호출은 검사하지 않는다 |

## 구조

| 파일 | 역할 |
|---|---|
| `src/index.ts` | 서버 진입점. stdout 은 프로토콜 전용이라 사람에게 하는 말은 stderr 로 |
| `src/tools.ts` | 도구 9개. description 은 `../TOOLS.md` 와 같은 계약 |
| `src/register.ts` | 등록 공통부. 기록·시간·오류 변환·`_meta` |
| `src/approvals.ts` | 승인 토큰 검사·소비, 승인 기록 |
| `src/runlog.ts` | 도구 호출 **전문** + 실행 메타. 요약만 남기면 사후에 되짚을 수 없다 |
| `src/chart.ts` | SVG 렌더링 + **근거 대조** (`render_chart`·`compose_card`가 공유) |
| `src/cards.ts` | 카드 합성·PNG·ZIP. 표지 삽화(agy 우선·로컬 폴백) |
| `src/live/` | live 모드 실제 API 호출부 (Vercel·Supabase·GitHub·권고) |
| `src/fixtures.ts` | 픽스처 로더. 실패를 담은 픽스처는 실패로 올린다 |
| `src/errors.ts` | `ToolError` — 오류를 예외가 아니라 도구 결과로 되돌린다 |
