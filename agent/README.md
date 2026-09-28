# 루프 래퍼 (Claude Agent SDK)

Claude Agent SDK 를 **`src/engine.ts` 한 파일에서만** 부른다. 화면(`../app`)은 이 모듈의 이벤트만 보고
SDK 를 직접 모른다 (수업 4절의 "엔진 호출 부분은 분리해 줘").

## 실행

```sh
npm install && npm run build   # 앱(../app)이 dist 를 가져다 쓴다. 실행은 화면에서 한다
```

종료 조건을 실제로 걸어 보려면 저장소 루트 `.env.local` 에 `OPS_MAX_TOOL_CALLS=2` 처럼 상한을 낮추고, 앱 서버를 다시 띄운 뒤 화면에서 실행한다
(앱은 서버가 뜰 때 `.env.local` 을 읽는다).

`ANTHROPIC_API_KEY` 는 저장소 루트의 `.env.local` 에서 읽는다 (`.env.local.example` 참고).
이미 설정된 환경변수는 덮어쓰지 않는다.

## 승인 게이트에서 토큰이 흐르는 방향

```
모델: create_github_issue 호출  (approval_token 없음)
   │
   ▼  PreToolUse 훅 ── 도구 표면 검사 ─────────▶ 목록 밖이면 deny
   │                └─ 토큰이 이미 있으면 ─────▶ deny (모델이 넣은 것이다)
   │
   ▼  _meta requiresUserInteraction → 항상 canUseTool 로
gate.ts ─── 사람에게 승인 요청 ──▶ 거절이면 behavior:'deny'
   │
   │ 승인
   ▼
issueToken()  ← 이 시점에 처음 토큰이 생긴다
   │
   ▼
behavior:'allow', updatedInput: { ...입력, approval_token }
   │
   ▼
MCP 서버가 토큰 검사 → 실행
```

**모델은 토큰을 아예 받지 않는다.** 그래서 지어내거나 재사용할 방법이 없다.
토큰은 승인 시점에 앱이 얹어 주고, 한 번 쓰면 소멸한다.

## 도구 표면

| | 무엇 | 왜 |
|---|---|---|
| `allowedTools` | 읽기 도구 **5개만** | 매번 물으면 브리핑을 만들 수 없다 |
| (목록에 없음) | 쓰기 도구 2개 | **넣으면 `canUseTool` 이 건너뛰어져 게이트가 무력화된다** |
| `disallowedTools` | `Bash` · `Write` · `Edit` · `Read` · `Glob` · `Grep` · `WebSearch` · `WebFetch` · `Task` · `TodoWrite` | 맨이름으로 적으면 도구 정의가 요청에서 빠져 모델이 존재조차 모른다 |
| `permissionMode` | `default` | `dontAsk` 는 `canUseTool` 을 부르지 않아 질문 대기와 승인이 **거부**된다 |

## 종료 조건

| 조건 | 누가 검사 |
|---|---|
| 최대 반복 20 | SDK `maxTurns` |
| 누적 비용 $1.00 | SDK `maxBudgetUsd` |
| 도구 호출 40 · 입력 토큰 200,000 · 실행 600초 · 같은 도구 연속 3회 | `src/limits.ts` |

`waiting_for_user` 시간은 실행 시간에서 뺀다. 사람을 기다리는 건 정상이다.
환경변수(`OPS_MAX_*`)로 상한을 낮춰 실제로 걸어 볼 수 있다.
SDK 가 두 상한으로 끝낸 실행(`error_max_turns` · `error_max_budget_usd`)도 우리 검사와 같이 `stopped` 로 적는다 (`stopReasonFromSubtype`, D44).

## 발행 게이트 (순수 로직)

`src/publish.ts` 는 브리핑을 슬랙으로 내보내기 전의 판정과 상태 전이를 **IO 없이** 담는다. 파일과 슬랙은 앱(`app/lib/publish.ts`)이 맡는다.

| 무엇 | 함수 · 값 |
|---|---|
| 도구 기록에서 신호 뽑기 | `signalsFromToolcalls` — 도구마다 마지막으로 성공한 호출만 |
| 기준 4개 | `GATE_RULES` — `deploy_failed` · `errors_up` · `stale_issue`(7일) · `tool_failed`. 각각 label · risk |
| 판정 | `evaluateGate({cards, signals}, {rules?})` — `rules` 로 조합을 바꿔 비교한다 |
| 상태 전이 | `initialPublishState` · `applyDecision` · `regate` · `beginSend` · `finishSend` (`MAX_RETRY = 2`) |
| 수정 적용 · 슬랙 메시지 | `applyEdits` · `buildSlackMessage` (블록 50개 · 3000자 한도) |
| 버린 기준 (비교용) | `CANDIDATE_RULES` — 카드 문장 기준 `fix_uncertain` · `fix_no_identifier` (D38) |

```sh
npm run gate-compare -- --set dev --detail    # dev · holdout · validation — 기준 조합별 개입률 · 놓침 · 헛멈춤
```

## 구조

| 파일 | 역할 |
|---|---|
| `src/engine.ts` | SDK 호출부. 여기서만 `query()` 를 부른다 |
| `src/gate.ts` | `canUseTool` — 질문 대기 + 쓰기 승인 + 토큰 주입 |
| `src/limits.ts` | 내가 검사하는 종료 조건 |
| `src/usage.ts` | 토큰·비용 집계. **모르는 것과 0 을 구별** |
| `src/hook.ts` | `PreToolUse` 훅 — 설정과 무관한 불변식 두 개 (게이트 ③) |
| `src/shadowguard.ts` | 게이트가 가려지면 실패시킨다 |
| `src/prompt.ts` | 시스템 프롬프트. EVAL.md 의 지표와 1:1 대응 |
| `src/tools.ts` | 허용·차단 도구 목록 |
| `src/publish.ts` | 발행 게이트 — 기준 · 상태 전이 · 슬랙 메시지 (위) |
| `src/env.ts` | 저장소 루트 `.env.local` 파서 (앱도 쓴다) |
| `scripts/gate-compare.mjs` | 게이트 기준 비교표 |

## 자체 검사

```sh
npm run check     # 100개. 모델·키 없이 돈다
```

| 검사 | 무엇을 막는가 | 경계 |
|---|---|---|
| `gate` | 승인 없는 쓰기, 대상 없는 승인, 허용 목록 밖 도구 | 읽기 도구는 게이트로 오지 않음. 쓰기는 `allowedTools` 에 없음 |
| `hook` | 허용 목록 밖 도구, **모델이 넣은 approval_token** | **토큰 없는 쓰기는 통과** — 여기서 막으면 사람이 묻기도 전에 차단된다 |
| `limits-usage` | 상한 초과, 결측을 0 으로 보고 | 다른 도구를 섞으면 연속 카운터 초기화. 값이 있으면 known |
| `shadowguard` | 게이트가 가려진 채 실행 | 관계없는 경고는 무시 |
| `publish` | 기준에 걸린 브리핑의 자동 발송 · 같은 답 두 번 · 사유 없는 반려 · 3번째 다시 판정 · 두 번 발송 · 슬랙 한도 초과 | 조용한 주는 자동 · 도구는 성공했는데 값이 없는 필드 · 지운 카드 되살리기 |
| `prompt` | 도구가 요구하는 것(분류 칸 · 영어 선택지 이름 · 의존성 목록)을 프롬프트가 말하지 않는 것 | — |
| `env` | `.env.local` 파싱 오류 | — |
