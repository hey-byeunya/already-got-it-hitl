# API_SPEC — 화면과 서버의 약속

API는 웹 화면이 서버에 요청하는 약속이다. 여기 적은 상태값과 규칙은 화면·서버·`EVAL.md`가
같은 뜻으로 쓴다.

---

## 상태 값

| 값 | 뜻 | 완료인가 |
|---|---|---|
| `planning` | 다음 행동을 정하는 중 | 아니다 |
| `running` | 도구 호출 중 | 아니다 |
| `waiting_for_user` | 사람의 선택·승인 대기 — **정상 상태** | 아니다 |
| `failed` | 재시도 소진. 부분 결과는 보존 | 아니다 |
| `stopped` | 종료 조건에 걸림 — 우리 검사 넷이든 SDK 가 끝낸 두 상한(`error_max_turns` · `error_max_budget_usd`)이든 같다 (D44) | 아니다 |
| `interrupted` | 대기 중이었는데 서버가 재시작돼 기다리던 콜백이 사라졌다. `POST /resume` 으로 잇는다 | 아니다 |
| `done` | 에이전트가 성공(`result.subtype = success`)으로 끝났다. **이 뒤에 발행 게이트가 돈다** | 그렇다 (에이전트 기준) |

잘못된 엔진 출력이나 모델의 "다 했다" 한 마디를 `done`으로 처리하지 않는다.
`done` 은 「카드를 다 만들었다」까지다. 바깥(슬랙)으로 내보낼지는 아래 **발행 게이트**가 따로 정한다 (D37).

## 엔드포인트

`구현`은 이 저장소에 라우트가 있다는 뜻이다. `미구현`은 계획만 있고 요청하면 404가 아니라
라우트 자체가 없다는 뜻이다 — 화면은 미구현 경로를 부르지 않는다.

| 메서드 · 경로 | 하는 일 | 입력 | 출력 | 오류 | 구현 |
|---|---|---|---|---|---|
| `GET /api/runs` | 실행 목록·픽스처 목록·자격증명 출처 | — | `{ runs[], fixtures[], credential_source }` | — | 구현 |
| `POST /api/runs` | 브리핑 실행 생성 | `{ fixture_id?, goal?, focus?, since?, until? }` | `{ run_id }` (201) | — | 구현 |
| `GET /api/runs/{id}` | 상태·대기 질문·진행 조회 | — | `RunState` + 유도값(`axes`·`cards`·`steps`·`links`·`exports`, 디스크에서 읽어 얹는다) | `run_not_found` 404 | 구현 |
| `DELETE /api/runs/{id}` | 실행 삭제 (두 번 눌러야 화면이 부른다) | — | `{ ok: true }` | `run_not_found` 404 · `run_is_live`·`invalid_run_id` 409 | 구현 |
| `GET /api/runs/{id}/trace` | 실행 로그 (도구·호출 이유·입력·결과·소요) | `?after=` | `{ events[] }` | — | 미구현 — `GET /api/runs/{id}`의 `trace`로 대신 본다 |
| `POST /api/runs/{id}/answers` | 질문 답변 제출 | `{ question_id, version, answers }` | `{ ok: true }` | `invalid_body` 400 · `already_answered`·`stale_version`·`stale_question`·`not_waiting`·`no_live_callback` 409 · `run_not_found` 404 | 구현 |
| `POST /api/runs/{id}/approvals` | **쓰기 도구 승인·거절** → 대기 콜백을 푼다 (토큰 발급은 콜백이 한다) | `{ approval_id, version, approved, reason? }` | `{ ok: true }` | `invalid_body` 400 · `already_decided`·`stale_version`·`stale_approval`·`not_waiting`·`no_live_callback` 409 · `run_not_found` 404 | 구현 |
| `GET /api/runs/{id}/approvals` | 승인 기록 조회 (되돌리기 대상 범위) | — | `{ approvals[] }` | — | 미구현 — `GET /api/runs/{id}`의 `decisions`로 대신 본다 |
| `POST /api/runs/{id}/storyboard/approve` | 스토리보드 승인 | `{ storyboard_version }` | `{ status }` | 버전 불일치면 거절 | 미구현 — 질문 대기(`AskUserQuestion`)로 대신 받는다 |
| `POST /api/runs/{id}/cards/{n}/revise` | 카드 하나만 수정 | `{ title?, body? }` | `{ card }` | 다른 카드 결과는 보존 | 미구현 — `compose_card`를 그 번호로 다시 부른다 |
| `POST /api/runs/{id}/resume` | 서버 재시작 후 재개 또는 재시도 | `{ mode: "resume"\|"retry" }` | `{ ok, mode }` | `run_not_found` 404 · `already_live`·`no_session_to_resume` 409 | 구현 |
| `POST /api/runs/{id}/export` | 카드뉴스 굽기 — **사람이 눌렀을 때만** | — | `exportCardnews` 결과 그대로 | `run_not_found` 404 · `already_exporting`·도구 오류 409 | 구현 |
| `GET /api/runs/{id}/export/[file]` | 결과물 내려받기. `zip`·`sources`·`NN.png` 세 형태만 받는다 | `?inline` (미리보기) | ZIP·PNG·`SOURCES.md` (스트리밍) | 형태 밖·없으면 400·404 | 구현 |
| `GET /api/runs/{id}/charts/{file}` | 카드 차트 SVG 서빙 | — | SVG | 없으면 404 | 구현 |
| `GET /api/runs/{id}/export` | PNG · ZIP · 근거 기록 | — | 파일 | 미승인이면 거절 | 미구현 — `export_cardnews` 도구 결과를 내려받는다 |
| `GET /api/runs/{id}/publish` | 발행 게이트 화면이 보는 것 — 발행 상태 · 걸린 기준(label · risk) · 판정에 쓴 신호 · 보낼 카드(고친 내용을 덮은 것) · 관련 카드 · DRY_RUN 여부. 읽을 때 갇힌 `retrying` 을 정리한다(`settleOrphanRetry`) | — | `PublishView` | `run_not_found`·`no_publish` 404 | 구현 |
| `POST /api/runs/{id}/publish` | **사람의 답** — 승인 · 수정 후 승인 · 반려 · 다시 판정 | `{ action: "approve"\|"edit"\|"reject"\|"retry", version, reason?, instruction?, edits?: [{card_no, title?, body?, remove?}] }` | `{ ok: true, publish }` | `invalid_body`·`reason_required`·`instruction_required`·`edits_required`·`all_cards_removed` 400 · `stale_version`·`invalid_transition`·`retry_limit`·`no_session_to_resume`·`run_is_live` 409 · `run_not_found`·`no_publish` 404 | 구현 |
| `POST /api/runs/{id}/publish/gate` | 게이트를 돌린다. 처음이면 판정(안 걸리면 곧바로 보냄), 대기·다시 판정 중이면 지금 카드로 **다시 판정**(여전히 사람 대기) | — | `{ ok: true, publish }` | `run_not_found`·`no_publish` 404 · `run_not_done`·`no_cards`·`invalid_transition`(이미 승인·반려·발행) 409 | 구현 |
| `POST /api/runs/{id}/publish/send` | 보내지 못한 건(`send_failed`)을 다시 보낸다 | — | `{ ok: true, publish }` | `no_publish` 404 · `invalid_transition`(이미 나간 건 등) 409 | 구현 |
| `GET /api/publish` | 발행 대기 목록 — 답할 건(대기 · 보내기 실패 · 다시 판정 중 에이전트가 묻는 건)과 지나간 건 | — | `{ rows[], waiting, dry_run }` | — | 구현 |

## 발행 게이트 (`runs/{id}/publish.json`)

에이전트가 `done` 으로 끝나면 `gateRun` 이 도구 기록(`toolcalls.jsonl`)에서 신호를 뽑아 기준 넷
(`deploy_failed` · `errors_up` · `stale_issue` · `tool_failed`)을 판정한다. 하나라도 걸리면 사람을 기다리고,
안 걸리면 곧바로 보낸다. `stopped` · `failed` · `interrupted` 실행은 게이트에 들어가지 않는다.

| 발행 상태 | 뜻 | 다음 |
|---|---|---|
| `pending_review` | 기준에 걸려 사람의 답을 기다린다 — **정상 상태**. 파일에 있어 재시작해도 남는다 | 승인 · 수정 후 승인 → `approved`, 반려 → `rejected`, 다시 판정 → `retrying` |
| `retrying` | 사람의 지시로 같은 에이전트 세션을 이어 돌리는 중 (최대 2번) | 끝나면 다시 판정해 **기준에 안 걸려도** `pending_review` 로 |
| `approved` | 보내도 된다 — 기준을 통과했거나(`route: auto`) 사람이 승인했다 | 곧바로 `sending` |
| `sending` | 보내는 중. **보내기 전에 먼저 쓴다** | `published` · `send_failed` |
| `published` | 나갔다 (또는 DRY_RUN 으로 `slack-dryrun.json` 에 남겼다). 끝 | — |
| `send_failed` | 웹훅 오류. 이유를 남기고 대기 목록의 답할 건에 올린다 | `POST /publish/send` → `sending` |
| `rejected` | 사람이 사유와 함께 반려했다. 끝 | — |

- **같은 답을 두 번 받지 않는다.** 답마다 `version` 이 1씩 오르고, 화면이 본 버전과 다르면 `stale_version` 이다.
- **같은 브리핑을 두 번 보내지 않는다.** 보내기 전에 `sending` 을 먼저 쓰고, 그 사이의 두 번째 요청은 `beginSend` 가 거절한다.
  슬랙 웹훅 메시지는 지울 수 없다.
- **수정은 원본을 건드리지 않는다.** `edits` 는 `publish.json` 에만 있고 `cards/*.json` 은 그대로다. `remove: true` 인 카드는 보내지 않는다.
- `PUBLISH_DRY_RUN` 은 보낼 때마다 `.env.local` 에서 다시 읽는다 (기본 `1`). 판정·전이는 순수 함수 `agent/src/publish.ts`, 파일·슬랙은 `app/lib/publish.ts`.

## 승인 토큰 규약

쓰기 도구(`create_github_issue` · `revert_issue`)는 유효한 `approval_token` 없이 실행되지 않는다.
검사는 **MCP 서버가** 한다 (`DECISIONS.md` D14 ②).

| 필드 | 뜻 |
|---|---|
| `token` | `apr_` + 예측할 수 없는 난수 (`node:crypto` `randomBytes`, D44) |
| `tool` | 이 토큰으로 부를 수 있는 도구 하나 |
| `target` | 대상 리소스 (저장소·이슈 번호 등) |
| `expires_at` | 만료 시각 |
| `used_at` | 사용 시각. **한 번 쓰면 소멸한다** |

| 상황 | 서버 응답 |
|---|---|
| 토큰 없음 | `approval_required` |
| 만료됨 | `approval_expired` |
| 다른 도구·다른 대상 | `approval_scope_mismatch` |
| 이미 사용됨 | `token_already_used` — **두 번 실행하지 않는다** |

## 기간 규약

화면은 기간을 "그 날까지 포함"으로 적는다 ("2026-09-03 ~ 2026-09-10"은 9/10 하루치를
포함한다는 뜻). 도구 세 개는 이 약속을 따른다.

| 입력 형태 | 읽는 법 |
|---|---|
| 날짜만 (`"2026-09-10"`) | **그 날 끝까지 포함**한다. 조회 경계에는 하루를 더해 넘긴다 |
| 시각 포함 (`"2026-09-10T07:37:00.000Z"`) | 정확한 instant 그대로. `toISOString` 값이 여기 해당한다 |

- 내부 조회는 half-open `[since, until)` 이다. 날짜만 온 `until`에 하루를 더하는 것은
  화면의 inclusive 읽기를 half-open 경계로 옮기는 일이다 — 기간을 늘리는 것이 아니다.
- `previous_period_totals`의 직전 기간은 이렇게 확정된 이번 기간과 같은 길이로 잰다.
- 이 규약을 어기면 until 당일 데이터가 통째로 빠져 "배포 0건" 같은 오표시가 난다 (D35).
  구현은 `mcp-server/src/live/period.ts` 한 곳에 있다.

## 중복 실행 방지

- 같은 `question_id` + `version`에 대한 답변은 **한 번만** 작업을 시작한다.
- 제출 버튼을 두 번 눌러도 제작이 두 번 돌지 않는다.
- 지난 버전 질문에 뒤늦게 답이 오면 "지난 질문"임을 알리고 **현재 작업을 덮어쓰지 않는다.**
- 같은 승인을 두 번 제출해도 이슈는 한 번만 만들어진다 (`token_already_used`).
- 같은 발행 답을 두 번 제출해도 슬랙에는 한 번만 나간다 (`stale_version` · `beginSend`).

## 새로고침과 서버 재시작

| 상황 | 서버 작업 | 앱이 해야 할 일 |
|---|---|---|
| 브라우저 새로고침 | 살아 있을 수 있다 | 저장된 질문·선택·단계를 다시 그린다 |
| 서버 재시작 | 메모리에서 기다리던 `canUseTool` 콜백은 **사라진다** | 중단 상태를 보여준 뒤 `POST /resume`으로 재개하거나 재시도하게 한다 |
| 서버 재시작 (발행 대기 중) | 기다리는 콜백이 없다 — `publish.json` 이 대기 자체다 | 아무것도 안 해도 대기 목록·실행 화면에 그대로 뜬다 |
| 서버 재시작 (다시 판정 중) | 이어 돌던 실행이 끊긴다 | 발행 상태를 읽을 때 `settleOrphanRetry` 가 정리한다 — done 이면 다시 판정, 아니면 이전 판정 그대로 대기로 |

세션 ID만 저장한다고 화면 상태와 작업이 자동 복구되지는 않는다.

## 사용량 응답 형태

`GET /api/runs/{id}`의 `usage`는 **모르는 것과 0을 구별한다** (`DECISIONS.md` D15).

```json
{ "usage_known": true,
  "input_tokens": 35995, "output_tokens": 1058,
  "cache_read_input_tokens": 12000, "cache_creation_input_tokens": 800,
  "total_cost_usd": 0.1842, "cost_is_estimate": true,
  "elapsed_seconds": 74.2, "waiting_seconds_excluded": 310.0 }
```

- `usage_known: false`면 나머지 수치를 **0으로 표시하지 않고 "확인 못 함"으로 그린다.**
  크래시(`error_during_execution`)나 예산 초과(`error_max_budget_usd`)에서 발생한다.
  예산 초과로 끝난 실행의 **상태**는 `failed` 가 아니라 `stopped` 다 (D44).
- `cost_is_estimate`는 항상 `true`다. 클라이언트 측 추정값임을 화면에 표시한다.
- 출력 토큰은 result 메시지에서 읽은 값이다 (per-step 값은 placeholder).
- 자격증명 출처는 `api_key`·`auth_token`·`stored_login` 중 하나다.

## 오류 표시

| 오류 | 화면에 보여줄 것 |
|---|---|
| 도구 조회 실패 | 원인 + 재시도 버튼. 그 축을 「확인 못 함」으로 표시 |
| 레이트 리밋 | 남은 시간 + 재시도 버튼 |
| 인증 실패 | 어느 토큰을 확인해야 하는지 안내 |
| `source_mismatch` | 차트 근거가 실제 도구 결과와 어긋남 — 조회부터 다시 |
| `approval_required` | 승인 화면으로 유도 |
| `stale_version` (발행) | 다른 곳에서 먼저 답했다 — 새로 읽고 다시 답하게 한다 |
| `send_failed` | 슬랙이 돌려준 이유 + `resend` 버튼. 승인은 이미 받은 건이라 다시 묻지 않는다 |
| 네트워크 실패 (답 보내기) | 「보내지지 않았으니 다시 누른다」 — 버튼을 잠근 채 두지 않는다 |
| 종료 조건 도달 | 어느 조건에 걸렸는지 + 지금까지의 결과 + 계속할지 묻기 |
| 자료 부족 | 무엇이 결측인지 나열. **0으로 채우지 않는다** |
