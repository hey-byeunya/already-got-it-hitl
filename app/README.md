# 화면 (Next.js)

운영 브리핑 실행을 사람이 보고 결정하는 화면. 엔진은 `../agent` 를 그대로 쓰고
**`Decider` 를 화면으로 구현한다** — 질문과 쓰기 승인을 사람이 결정한다.

## 실행

```sh
npm install
npm run dev        # http://localhost:3010 (이미 쓰고 있으면 npx next dev -p 3011)
npm run typecheck  # tsc --noEmit
```

`ANTHROPIC_API_KEY` 는 저장소 루트의 `.env.local` 에서 읽는다. 키가 없으면 구독 로그인으로
시도하고, 시작 화면은 지금 무엇으로 도는지 모드 배지(`LIVE`/`FIXTURE`)로 말한다.
실행 버튼을 잠그지 않는다 — 막으면 구독으로 도는 경로를 코드가 닫아 버린다.

## 화면

| 경로 | 무엇을 보여주는가 |
|---|---|
| `/` | 모드 배지 · 기간·축·픽스처로 새 실행 · 추천 4종 · 즐겨찾기 · 지난 실행(10건씩 쪽넘김) · 실행 삭제 |
| `/runs/{id}` | 진행 상태 · 질문 대기 · 승인 대기 · **발행 게이트**(`[ PUBLISH GATE ]`) · 실행 비용 · 결정 이력 · 카드 차트 · 브리핑 원고 · 실행 로그 · 카드뉴스 내보내기 |
| `/publish` | 발행 대기 목록 — 답할 건 · 지나간 건. 홈 머리의 `[ PUBLISH ] waiting N` 에서 들어간다 |
| `GET·POST /api/runs/{id}/publish` | 승인 화면이 보는 것 / 사람의 답 (승인 · 수정 · 반려 · 다시 판정) |
| `POST /api/runs/{id}/publish/gate` | 다시 판정 (데모 심기도 이것을 부른다) |
| `POST /api/runs/{id}/publish/send` | 보내지 못한 건 다시 보내기 |
| `GET /api/publish` | 대기 목록 · 답할 건수 · DRY_RUN 여부 |
| `POST /api/runs/{id}/export` | 사람이 누를 때만 굽는다. `already_exporting`이면 409 |
| `GET /api/runs/{id}/export/[file]` | `zip`·`sources`·`NN.png` 세 형태만 내려준다 |
| `DELETE /api/runs/{id}` | 실행 삭제. 돌고 있는 것은 `run_is_live`로 거절 |

## 발행 게이트

에이전트가 `done` 으로 끝나면 `lib/publish.ts` 의 `gateRun` 이 기준 넷을 판정해, 걸리면 `runs/{id}/publish.json` 에 대기시키고
안 걸리면 곧바로 슬랙으로 보낸다(`PUBLISH_DRY_RUN=1` 이면 `slack-dryrun.json` 에만). 화면은 `components/run/publish.tsx`
(`usePublish` · `PublishGate` · `PublishDecisions`)와 `components/run/cards.tsx`(관련 카드 강조 · 카드 자리에서 고치기)다.
계약은 `../API_SPEC.md` 「발행 게이트」, 설계는 `../REPORT.md`.

## 이 화면이 채점 항목에 대응하는 방식 (Main Quest 4)

| 채점 | 화면에서 |
|---|---|
| 2. 도구 · 권한 최소화 | **승인 대기 카드** — 무엇을 쓰려는지 펼쳐 본 뒤 승인/거절. 거절 이력이 남는다 |
| 3. 루프 · 상태 관리 | **질문 대기**(정상 상태로 표시) · **중단 후 재개/재시도** · 종료 조건 패널 |
| 4. 관찰 가능성 | **실행 로그** — 도구 이름·입력·출력 **전문**을 펼쳐 본다. 소요 시간·토큰·비용 |

## 상태를 두 겹으로 두는 이유

```
디스크  runs/{id}/ui-state.json   질문·답변·단계·로그·비용   → 새로고침·재시작 후에도 남는다
메모리  resolver 맵                대기 중인 콜백              → **재시작하면 사라진다**
```

이 구별이 채점 3번의 핵심이다. 세션 ID 만 저장한다고 화면 상태와 작업이 복구되지 않는다.

발행 대기는 이 두 겹에 들지 않는다. `runs/{id}/publish.json` **디스크에만** 있고 기다리는 콜백이 없어,
서버가 재시작해도 `interrupted` 가 되지 않고 그대로 이어진다 (D37).

- **새로고침**: 서버 작업이 살아 있다. 저장된 상태를 다시 그리고 그대로 이어간다.
- **서버 재시작**: 콜백이 사라졌다. 화면은 `interrupted` 로 바뀌고, 걸려 있던 질문·승인을
  **읽기 전용으로만** 보여준다 — 누를 수 없는 버튼을 보여주지 않기 위해서다.
  저장한 세션 ID 로 재개하거나 처음부터 재시도한다.

## 거절되는 요청

| 상황 | 응답 |
|---|---|
| 지난 버전 질문에 뒤늦게 답변 | `409 stale_version` — 현재 작업을 덮어쓰지 않는다 |
| 같은 답변·승인을 두 번 제출 | `409 already_answered` / `already_decided` — 두 번 실행되지 않는다 |
| 재시작 후 답변·승인 제출 | `409 no_live_callback` — 상태만 고쳐도 작업은 이어지지 않는다 |
| 이미 돌고 있는 실행을 재개 | `409 already_live` |
| 이어갈 세션이 없는데 재개 | `409 no_session_to_resume` — 재시도를 안내한다 |
| 발행 — 다른 곳에서 먼저 답했다 | `409 stale_version` — 두 번 보내지 않는다 |
| 발행 — 사유 없는 반려 · 지시 없는 다시 판정 · 아무것도 안 고친 수정 · 카드를 다 지운 수정 | `400 reason_required` · `instruction_required` · `edits_required` · `all_cards_removed` |
| 발행 — 다시 판정 3번째 · 이미 나간 건 다시 보내기 | `409 retry_limit` · `invalid_transition` |

## 비용 표시

`usage_known: false` 인 실행은 숫자를 **0 으로 표시하지 않고 "확인 못 함"** 으로 그린다.
토큰은 이미 썼기 때문이다. 아는 값(캐시 읽기 등)은 그대로 보여준다.

비용은 항상 **추정값**임을 함께 적는다. SDK 가 번들된 단가표로 로컬 계산하며 실제 청구액과 다를 수 있다.

## 화면만 확인하고 싶을 때

모델을 부르지 않고 화면을 보려면 상태를 심는다. 서버를 띄운 채로:

```sh
npm run demo:gate     # 발행 게이트 — 대기 3편 · 자동 발행 1편. 서버가 DRY_RUN 일 때만 심는다
```

`demo:gate` 는 `fixtures/publish-gate/` 의 합성 픽스처 실행 셋과 `scripts/demo-inputs/quiet-week/`(데모용으로 만든 조용한 주)의 카드 · 도구 기록을 복사해 서버에 판정을 부른다 — 판정은 실제와 같은 코드다.
다른 포트면 `npm run demo:gate -- http://localhost:3011`.
**실제 실행 기록이 아니다** — `demo-` 접두어로 구별하며, 평가나 증거로 쓰지 않는다.
