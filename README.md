# 「이미 있어」 주간 운영 브리핑 — 사람이 승인하는 발행 게이트

주간 운영 브리핑 카드뉴스를 **슬랙으로 발행하기 직전**, 기준에 걸린 브리핑만 사람에게 세우고
나머지는 자동으로 내보내는 HITL(human-in-the-loop) 프로젝트다.

모두의연구소 「에이전트 팀 꾸리기 (Agt1)」 10단원 「사람이 승인하는 에이전트 만들기」 제출물이며,
Main Quest 4 제출본 [already-got-it-agent](https://github.com/hey-byeunya/already-got-it-agent)를 복사해 시작했다.

- **보고서**: [REPORT.md](./REPORT.md) — 주제 · 파이프라인 구조도 · 승인 기준 · 실행 결과 · 화면 설계 · 회고
- **대상 앱**: [이미 있어](https://already-got-it.vercel.app) ([hey-byeunya/already-got-it](https://github.com/hey-byeunya/already-got-it))
- **저장소**: [hey-byeunya/already-got-it-hitl](https://github.com/hey-byeunya/already-got-it-hitl)
- **실행**: 로컬 (`npm run dev`). 배포하지 않는다

## 이번에 더한 것 — 발행 게이트

```
에이전트 실행 ─ done ─▶ 기준 4개 판정 ─ 안 걸림 ─▶ 슬랙 발송 (자동)
                              └ 걸림 ─▶ ⏸ runs/{id}/publish.json (pending_review)
                                          └ 사람: approve · edit & approve · reject · retry
```

| 기준 | 계산 (도구 데이터) |
|---|---|
| `deploy_failed` | 실패한 배포 ≥ 1 |
| `errors_up` | 앱 에러가 직전 기간보다 늘었다 (둘 다 값이 있을 때만) |
| `stale_issue` | 가장 오래 열린 이슈 ≥ 7일 |
| `tool_failed` | 시스템·사용자·개발 활동 도구 중 한 번도 성공하지 못한 것이 있다 |

- 대기는 파일(`publish.json`)에 남아 **서버를 재시작해도 이어진다.** 같은 답을 두 번 보내도 한 번만 나간다.
- 화면: 실행 화면의 `[ PUBLISH GATE ]` 구역, 대기 목록 `/publish`, 홈 머리의 `[ PUBLISH ] waiting N`.
- 판정 · 상태 전이는 순수 함수 `agent/src/publish.ts`, 파일 · 슬랙은 `app/lib/publish.ts`.
- 기준을 고른 과정과 숫자는 [REPORT.md](./REPORT.md) 3·4절, 결정 기록은 [DECISIONS.md](./DECISIONS.md) D37~D50.

<img src="evidence/hitl/hitl-03-gate-pending.png" alt="승인 구역 — 멈춘 이유, 판정에 쓴 값, 통과시키면, 네 가지 답" width="720">

## 실행

```sh
cd mcp-server && npm install && npm run build
cd ../agent && npm install && npm run build
cd ../app && npm install && npm run dev        # http://localhost:3010
# 3010 을 다른 서버가 쓰고 있으면: npx next dev -p 3011
```

### 모델 없이 승인 화면만 보기 (데모)

에이전트를 돌리지 않고 발행 게이트를 바로 열어 볼 수 있다. 합성 픽스처로 돌린 실행의 카드 · 도구 기록(`fixtures/publish-gate/`)과
데모용으로 만든 조용한 주(`app/scripts/demo-inputs/quiet-week/`)를 `runs/demo-gate-*` 로 복사하고, 떠 있는 서버에 판정을 부른다 — 판정은 실제 실행과 같은 코드가 한다.

```sh
cp .env.local.example .env.local     # 처음 한 번. PUBLISH_DRY_RUN=1 그대로 둔다
cd app && npm run dev                # 다른 창에서
cd app && npm run demo:gate          # 서버가 3010 이 아니면: npm run demo:gate -- http://localhost:3011
```

| 데모 | 보이는 것 |
|---|---|
| `demo-gate-error-creep` | 앱 에러 2→9 — `errors_up` 으로 멈춤 |
| `demo-gate-deploy-fail` | 배포 실패 · 에러 1→6 — 기준 두 개에 걸림 |
| `demo-gate-tool-failed` | 사용자 지표 조회 실패 — `tool_failed`. 카드 수정 · 삭제를 해 보기 좋다 |
| `demo-gate-quiet-week` | 조용한 주(데모용으로 만든 입력) — 기준 통과, 사람을 거치지 않고 자동 발행(DRY_RUN) |

`http://localhost:3010/publish` 에서 대기 건을 열어 approve · edit & approve · reject 를 눌러 본다.
다시 부르면 처음 상태로 돌아간다. 서버가 `PUBLISH_DRY_RUN=0` 이면 아무것도 심지 않고 멈춘다 (통과한 건이 실제로 나가지 않게).
retry 는 이어 돌릴 에이전트 세션이 없어 꺼져 보인다.

### 에이전트로 한 편 돌리기

1. 루트의 `.env.local.example` 을 `.env.local` 로 복사한다. **픽스처 모드(`OPS_MODE=fixture`)면 외부 키 없이** 화면·게이트·DRY_RUN 발행까지 돈다.
   에이전트 실행에는 `ANTHROPIC_API_KEY` 또는 Claude 로그인(구독)이 필요하다.
2. 홈에서 픽스처(예: `f6-error-creep`)를 골라 실행한다. 끝나면 게이트가 판정한다 — f6 은 `errors_up` 으로 멈춘다.
3. 실행 화면의 `[ PUBLISH GATE ]` 에서 답한다. 기본값(`PUBLISH_DRY_RUN=1`)에서는 슬랙으로 보내지 않고 `runs/{id}/slack-dryrun.json` 에만 남긴다.

### 슬랙으로 실제로 보내려면

1. 슬랙 앱을 만들고 **채널**(예: `#ops-brief`)에 Incoming Webhook 을 추가한다. 앱 DM 용 웹훅은 `messages_tab_disabled` 로 거절됐다.
2. `.env.local` 에 `SLACK_WEBHOOK_URL=` 을 넣고 `PUBLISH_DRY_RUN=0` 으로 바꾼다. 서버 재시작은 필요 없다 — 보낼 때마다 다시 읽는다.
3. **웹훅으로 보낸 메시지는 지울 수 없다.** 시험이 끝나면 `PUBLISH_DRY_RUN=1` 로 되돌린다.
   웹훅 주소는 비밀값이다 — 저장소나 채팅에 붙이지 않는다.

### 기준 비교표 · 검사

```sh
cd agent && npm run gate-compare -- --set dev --detail         # holdout · validation 도 같다
cd agent && npm run check        # 판정·전이·슬랙 한도 포함 100개
cd mcp-server && npm run check   # 도구 114개
cd app && npm run typecheck
```

---

아래는 원래 에이전트(Main Quest 4)의 설명이다. 게이트 앞에서 카드뉴스를 만드는 부분이다.

## 무엇을 해결하는가

앱을 하나 배포해 두면 매주 같은 점검을 반복한다 — 배포가 깨지지 않았는지, 함수가 오류를 내지
않는지, 사용자가 늘고 있는지, 열어 둔 이슈가 쌓이고 있는지, 쓰는 라이브러리에 보안 권고가 뜨지
않았는지.

문제는 **이 넷이 서로 다른 화면에 흩어져 있다**는 것이다. 네 곳을 각각 열어야 하고, 각 화면은
숫자를 보여주지만 "지금 중요한 게 무엇인지"는 말해 주지 않는다. 그래서 며칠씩 안 열어 보고,
그동안 문제는 아무 소리 없이 지나간다.

**이 서비스가 겨냥하는 실패는 틀린 답이 아니라 조용한 실패다.** 오류율이 올라가도 아무도 말해
주지 않는 상태를, 매주 한 번 사람이 읽을 수 있는 형태로 바꾼다.

각 카드는 셋 중 하나다: **지금 손봐야 할 것** · **지켜볼 것** · **알아둘 것**.

핵심 제약 하나 — **근거 없는 수치를 카드에 넣지 않는다.** 운영 판단의 근거가 되는 문서이므로
환각은 곧 기능 실패다. `EVAL.md`에서 환각률을 첫 번째 지표로 잰다.

## 연결한 도구

도구 9개는 `mcp-server/`에 **독립 stdio MCP 서버**로 한 번만 구현하고, 앱은 Agent SDK로,
Claude Code는 `.mcp.json`으로 같은 서버를 붙여 쓴다.

| 도구 | 유형 | 권한 | 실행 전 확인 |
|---|---|---|---|
| `get_system_health` | Vercel REST API | 읽기 전용, 해당 프로젝트만 | — |
| `get_user_metrics` | Supabase 집계 RPC | **집계값만**, 원시 행 없음 | — |
| `get_dev_activity` | GitHub API | 읽기 전용, 본인 저장소만 | — |
| `web_search` | 웹 검색 | 읽기 전용 | — |
| `render_chart` | 앱 내부 (SVG) | 외부 호출 없음. 근거 없이는 거절 | — |
| `compose_card` | 앱 내부 (SVG 합성) | `runs/{run_id}/` 아래만 쓰기. 근거 형식 어긋나면 거절 | — |
| `export_cardnews` | 앱 내부 (PNG·ZIP) | 사람이 눌렀을 때만 굽는다 | — |
| `create_github_issue` | GitHub **쓰기** | issue 생성만 | **필수** |
| `revert_issue` | GitHub **쓰기** | 승인 기록에 있는 이슈만 닫기 | **필수** |

쓰기 도구는 에이전트가 직접 실행하지 못한다. 제안만 만들고, 사람이 승인해야 실행된다.
삭제 권한은 어떤 도구에도 없다. Agent SDK 내장 도구(`Bash`·`Write`·`Edit` 등)는 차단한다.
자세한 스키마와 실패 규칙은 `TOOLS.md`.

### 승인 게이트는 세 겹이다

Agent SDK 문서가 경고하듯 **자동 승인된 도구는 `canUseTool` 콜백에 도달하지 않는다.** 도구를 모두
허용 목록에 넣으면 승인 화면이 아예 뜨지 않는다 — 게이트가 있는 줄 알았는데 없는 상태다.
그래서 세 겹으로 막았다.

1. MCP 서버가 쓰기 도구에 `_meta["anthropic/requiresUserInteraction"]`를 선언 → allow 규칙이
   매치돼도 항상 승인 콜백으로 떨어진다. **게이트가 앱 설정이 아니라 도구의 성질이 된다.**
2. MCP 서버가 1회용 `approval_token`을 검사 → 앱을 우회해 서버에 직접 붙어도 막힌다.
3. `PreToolUse` 훅이 **설정과 무관한 불변식 두 개**를 검사 → 모든 단계보다 먼저 실행되고,
   훅의 deny는 `bypassPermissions`에서도 유효하다. 허용 목록 밖의 도구, 그리고 **모델이 스스로
   넣은 `approval_token`** 을 거절한다. (훅은 `canUseTool`보다 먼저 돌기 때문에 "승인 기록이
   있는지"는 검사하지 않는다 — 거기서 막으면 사람이 묻기도 전에 모든 쓰기가 차단된다.)

덤으로 자체 검사가 하나 생겼다. 콜백이 가려지면 SDK가 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 경고를
띄우므로, 이를 잡아 **실패로 처리**한다. 자세한 근거는 `DECISIONS.md` D14.

## 문서

| 파일 | 내용 |
|---|---|
| [PRD.md](./PRD.md) | 문제 정의 · 타겟 유저 · 워크플로 설계 · 도구 계획 · 사람 개입 지점 · MVP와 화면 |
| [TOOLS.md](./TOOLS.md) | 도구 9개의 입출력 스키마 · description · 실패 규칙 · 권한 |
| [AGENT_LOOP.md](./AGENT_LOOP.md) | 계획→호출→관찰→다음행동 루프 · 상태 관리 · 종료 조건 |
| [API_SPEC.md](./API_SPEC.md) | 화면과 서버의 약속 — 상태값 · 중복 방지 · 새로고침과 재시작 |
| [EVAL.md](./EVAL.md) | 평가 세트 · 지표 · 세팅 변화 실험표 · 실패 사례 |
| [RUN.md](./RUN.md) | 실행 방법 · 환경변수 · 수용 기준 · 캡처 목록 |
| [REPORT.md](./REPORT.md) | HITL 발행 게이트 보고서 |
| [DECISIONS.md](./DECISIONS.md) | 선택과 이유 (D1~D50, 발행 게이트는 D37~) |
| `fixtures/` | 평가용 운영 스냅샷 6개 (정답 포함) · `publish-gate/` 게이트 검증 데이터와 정답 라벨 |
| `evidence/hitl/` | 발행 게이트 화면 캡처 13장 |

읽는 순서는 `PRD.md` → `DECISIONS.md` → `TOOLS.md` → `AGENT_LOOP.md` → `EVAL.md`를 권한다.

## 환경변수

환경변수는 `RUN.md`의 표를 참고한다. `.env.local`은 저장소에 넣지 않는다.
Supabase `service_role` 키는 어디에도 쓰지 않는다.
