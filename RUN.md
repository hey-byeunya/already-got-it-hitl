# RUN — 실행 방법 · 수용 기준 · 캡처 목록

제출은 **GitHub 저장소 URL + 실제 결과물 캡처본**이다. 배포하지 않는다.
그래서 **캡처가 유일한 동작 증거**다 — 단계마다 즉시 남긴다.

---

## 구성

```
mcp-server/     도메인 도구 9개, stdio MCP 서버 (구현은 여기 한 곳)
app/            Next.js — 화면, 루프 래퍼, 승인 게이트, 실행 기록
                lib/publish.ts        발행 게이트 IO — publish.json · 슬랙 발송 · 다시 판정
                scripts/              발행 게이트 데모 심기 (demo:gate)
agent/          Agent SDK 루프 래퍼 (앱이 가져다 쓴다)
                src/publish.ts        발행 게이트 순수 로직 — 기준 4개 · 상태 전이 · 슬랙 메시지
                scripts/gate-compare.mjs  기준 조합별 개입률 · 놓침 · 헛멈춤 비교표
fixtures/       snapshots/ 운영 스냅샷 6개 (정답 포함)
                publish-gate/ 게이트 검증 데이터 — 합성 픽스처 실행 9편(dev 3 · holdout 4 · validation 2) + 정답 라벨
                              (실제 데이터 8편은 공개 저장소에 넣지 않았다 — D46)
evidence/hitl/  발행 게이트 화면 캡처 13장
```

## 실행

```sh
# 도구 서버·에이전트 빌드
cd mcp-server && npm install && npm run build
cd ../agent && npm install && npm run build
# 화면 (http://localhost:3010 — 이미 쓰고 있으면 npx next dev -p 3011)
cd ../app && npm install && npm run dev
```

브라우저에서 `http://localhost:3010`을 연다.

모델을 부르지 않고 화면만 보려면 서버를 띄운 채로:

```sh
cd app && npm run demo:gate     # 발행 게이트 — 대기 3편 · 자동 발행 1편 (DRY_RUN 일 때만 심는다)
```

다른 포트면 `npm run demo:gate -- http://localhost:3011`. `demo-gate-` 로 시작하는 실행을 만들고, 실제 실행 기록이 아니다.

## 검사

```sh
cd mcp-server && npm run check   # 도구 · 승인 토큰 · 근거 대조 · 카드 분류 — 114개
cd agent && npm run check        # 종료 조건 · 사용량 · 쓰기 게이트 · 발행 게이트 판정·전이 · 슬랙 한도 — 100개
cd app && npm run typecheck      # tsc --noEmit
cd agent && npm run gate-compare -- --set dev --detail   # holdout · validation 도 같다
```

Claude Code에서 같은 MCP 서버를 붙여 쓰려면 `.mcp.json`에 등록한다 (확장① 증거).

```sh
cat .mcp.json   # already-got-it-ops 등록 확인
# Claude Code에서 /mcp → 도구 9개가 뜨는지 확인한다
```

## 환경변수

저장소에 실제 값을 넣지 않는다. `.env.local.example`에 형식만 둔다.

| 변수 | 용도 | 공개 가능 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude Agent SDK | **불가** |
| `VERCEL_API_TOKEN` | `get_system_health` — 읽기 전용 | **불가** |
| `VERCEL_PROJECT_ID` | 조회 대상 프로젝트 한정 | 가능 |
| `GITHUB_TOKEN` | `get_dev_activity` · `create_github_issue` · `revert_issue` | **불가** |
| `GITHUB_ALLOWED_REPOS` | 허용 저장소 목록. 밖은 도구가 거절 | 가능 |
| `NEXT_PUBLIC_SUPABASE_URL` | 데이터 소스 | 가능 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 집계 RPC 접근 | 가능 |
| `OPS_MODE` | `fixture` 기본 · `live`면 실제 API. 화면 배지가 매번 다시 읽어 표시한다 | 가능 |
| `OPS_FIXTURE_ID` | 픽스처 기본값. live에서는 서버도 무시한다 | 가능 |
| `GITHUB_ALLOWED_LABELS` | 임의 라벨 금지 목록 | 가능 |
| `OPS_APPROVAL_TTL` | 승인 토큰 유효 초 (기본 600) | 가능 |
| `OPS_METRICS_TOKEN` | 집계 RPC 비밀값. SQL 안의 값과 같아야 한다 | **불가** |
| `OPS_ALLOW_LIVE_WRITES` | `1`이면 실제 이슈 생성·닫기 허용 (기본 `0`) | 가능(값이 `0`일 때) |
| `SLACK_WEBHOOK_URL` | 발행 게이트가 브리핑을 보내는 슬랙 웹훅 주소. 보낸 메시지는 지울 수 없다 | **불가** |
| `PUBLISH_DRY_RUN` | `1`(기본)이면 보내지 않고 `runs/{id}/slack-dryrun.json` 에만 남긴다. `0`이면 실제로 보낸다 | 가능 |

- Supabase `service_role` 키는 **어디에도 쓰지 않는다.** 집계는 `security definer` RPC로만 접근한다.
- `GITHUB_TOKEN`은 **issue 읽기·생성·닫기 범위만** 준다. 저장소 쓰기·삭제 권한을 주지 않는다.

## 발행 게이트 — 슬랙으로 내보내기 전

실행이 `done` 으로 끝나면 게이트가 도구 기록으로 기준 넷을 판정한다 (`REPORT.md` 3절, `API_SPEC.md` 「발행 게이트」).

1. 홈에서 픽스처 `f6-error-creep` 로 실행한다 → 끝나면 `errors_up`(앱 에러 2→9)으로 멈춘다.
   모델 없이 보려면 `npm run demo:gate`.
2. 홈 머리의 `[ PUBLISH ] waiting N` 또는 `/publish` 에서 대기 건을 연다.
3. 실행 화면의 `[ PUBLISH GATE ]` 에서 답한다.
   - `approve - send as is` — 그대로 보낸다
   - `edit & approve` — `[ CARDS ]` 의 카드 자리에서 제목 · 본문을 고치거나 카드를 지운 뒤 보낸다 (원본 파일은 그대로)
   - `reject` — 사유를 적어야 눌린다. 보내지 않는다
   - `retry (n/2)` — 지시를 적으면 같은 에이전트 세션을 이어 돌려 카드를 고치고 **다시 사람에게** 보인다. 비용이 든다
4. `PUBLISH_DRY_RUN=1`(기본)이면 `runs/{id}/slack-dryrun.json` 에만 남는다.
   실제로 보내려면 채널용 Incoming Webhook 을 `SLACK_WEBHOOK_URL` 에 넣고 `PUBLISH_DRY_RUN=0` —
   보낸 메시지는 지울 수 없으니 시험이 끝나면 `1` 로 되돌린다. 발송이 실패하면 `resend` 로 다시 보낸다.

## live 실행 — 실제 API로 브리핑 한 편

평가는 픽스처로 재현하지만, 실제 운영에서는 이 모드로 돈다. `.env.local` 의 `OPS_MODE=live` 로 바꾸고 화면에서 실행한다 —
홈 머리의 모드 배지가 `LIVE` 로 바뀐다 (서버 재시작 없이 매번 다시 읽는다).

실행 전 확인 (하나라도 빠지면 읽기 축이 `확인 못 함`이 된다):

- [ ] `.env.local`에 `VERCEL_API_TOKEN`·`VERCEL_PROJECT_ID`·`GITHUB_TOKEN`·
  `NEXT_PUBLIC_SUPABASE_URL`·`NEXT_PUBLIC_SUPABASE_ANON_KEY`·`OPS_METRICS_TOKEN`이 있는가
- [ ] `supabase/ops_metrics.sql`을 Supabase SQL Editor에서 실행했는가.
  안 하면 `get_user_metrics`가 `rpc_not_created`로 죽고 사용자 지표 축 전체가 빈다
- [ ] 실제 쓰기를 원하지 않으면 `OPS_ALLOW_LIVE_WRITES=0`인가 (기본값).
  쓰기 제안은 화면의 승인 대기에서 거절하면 거절 기록으로 남는다

첫 live 실행 (2026-09-10, `live-t1`, 구독 로그인, 승인 없음):

- `done (success)` — 도구 호출 24회, 실행 346.7초, 비용 $0.7940 추정(구독이라 미청구).
  카드 6장 + PNG 6장 + ZIP(`cards/*.png` + `SOURCES.md`) 전부 열림.
- Vercel 배포 0건 · GitHub 이슈·커밋·PR 0건 · 보안 권고 3종(next critical RCE 2건 포함).
- Supabase RPC 미생성이라 사용자 지표 축은 `확인 못 함` — SQL 실행이 남은 사람 몫이다.
  → **해소 (2026-09-10)**: SQL 실행 후 `smoke-live` 3번이 집계 반환 확인.
  7일 series + totals + 직전 기간 비교값, `unavailable_fields: []`, 원시 행 없음.
  이번 기간 전부 0, 직전 기간 활성 사용자 1 — 실제 0이지 결측이 아니다.
- 지어낸 근거 카드가 `source_not_found`로 거절된 뒤 모델이 내용을 바꿔 완성했다 (P1-7(a) live 증거).
- 이슈 생성 제안 2건은 승인 없이 거절됐고 `permission_denials` 2건이 기록에 남았다.

두 번째 live 실행 (2026-09-10, `live-t2`, 구독 로그인, 승인 없음):

- `done (success)` — 도구 호출 22회, 실행 178.5초, 비용 $0.3744 추정(미청구).
- RPC 해소 후라 사용자 지표 카드가 정상 수치로 나왔다 (전부 0 + 차트, 전 기간 활성 1명 병기).
- 모델이 GHSA ID를 `field`에 넣어 `invalid_source_field`로 2번 거절당하고 고쳐서 완성했다.
- 이슈 제안 1건 거절, `permission_denials` 1건. 전회($0.79)의 절반 — 같은 조건도 편차가 크다.

## 픽스처 실행 모드

평가와 캡처를 재현할 수 있게, 외부 API 응답과 기준 시각을 픽스처로 고정 주입하는 모드를 둔다.

- 실제 API를 쓰면 실행 시점마다 결과가 달라져 **세팅 변화의 효과를 판정할 수 없다.**
- 픽스처 모드에서는 쓰기 도구가 실제 GitHub를 바꾸지 않는다. 승인 화면과 결과 표시는 그대로 동작하되
  대상이 픽스처 사본이다. **화면에 이 사실을 표시한다.**

`OPS_MODE=fixture`(기본)이면 홈에서 고른 픽스처로 돈다. 쓰기 도구를 승인해도 픽스처라 실제 저장소는 안 바뀐다.

## 실행 전 확인

- [ ] `.env.local`이 `.gitignore`에 있는가
- [ ] 저장소에 키·토큰이 없는가 (`git log`까지 확인)
- [ ] `GITHUB_TOKEN`의 범위가 읽기 + issue 로 한정돼 있는가 (live 에서 커밋 · PR 을 읽으려면 Contents · Pull requests **Read** 가 필요하다. 없으면 매주 `tool_failed` 로 멈춘다 — D43 후속)
- [ ] `PUBLISH_DRY_RUN=1` 인가 (시험 발송이 끝났으면 되돌렸는가)
- [ ] `SLACK_WEBHOOK_URL` 이 `.env.local` 에만 있는가
- [ ] `service_role` 키를 쓰지 않는가
- [ ] 종료 조건(`maxTurns`·`maxBudgetUsd` 등)이 기본값으로 걸려 있는가
- [ ] `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 경고 감시가 켜져 있는가 (게이트가 가려지면 실패시킨다)

## 수용 기준

로컬 실행에서 이 기준으로 동작을 확인한다.

> **픽스처 4개 전부, 사람 개입 지점 외의 중단 없이 내보내기까지 도달했다 (E0, 12/12 완주).**
> 그리고 `f4-sparse`에서는 카드를 억지로 만들지 않고 자료 부족을 알려야 한다.

| 시나리오 | 기대 | 실제 | 통과 |
|---|---|---|---|
| `f1-normal` 정상 주간 | 큰 문제 없음을 확인하고 지켜볼 것 위주로 구성 | 문제없음 확인, 억지 진단 없음 (3/3) | O |
| `f2-deploy-fail` 배포 실패 | 실패한 배포를 `지금 손봐야 할 것`으로 1번 카드에 | 빌드 오류 원문 그대로 카드화. 필수신호 0.67이라 1번 배치까지는 장담 못 함 | △ |
| `f3-metric-drop` 지표 급감 | 전주 대비 감소를 근거와 함께 제시. 원인을 단정하지 않음 | 원인 단정 회피 3/3, 추정 표기 | O |
| `f4-sparse` 자료 부족 | **카드를 만들지 않고** 무엇이 부족한지 알림 | 4장으로 축소, 결측과 0 구별 (3/3) | O |

- 확인 일자: 2026-09-09 (E0 기준 실행, 원래 저장소) · live `live-t1` 2026-09-10은 `RUN.md` live 실행절 참조

### 발행 게이트 수용 기준 (2026-09-28)

| 시나리오 | 기대 | 실제 | 통과 |
|---|---|---|---|
| 기준에 걸린 브리핑 | 보내지 않고 `pending_review` 로 멈춘다 | 새 실행 9편 중 8편 멈춤 (`REPORT.md` 4-1) | O |
| 기준을 통과한 브리핑 | 사람을 거치지 않고 보낸다 | f4(당시 기준) · `slack-test-0921`(실제 슬랙) 자동 발송 | O |
| 대기 중 서버 재시작 | 대기가 그대로 남는다 | `publish.json` 에서 다시 읽힘 | O |
| 승인 · 수정 후 승인 · 반려 · 다시 판정 | 각각 보냄 · 고친 카드로 보냄 · 보내지 않음 · 다시 돌려 다시 사람에게 | 네 경로 모두 실제로 지남 (반려는 테스트와 데모) | O |
| 같은 답을 두 번 | 한 번만 보낸다 | 두 번째 `stale_version` 409, 발송 뒤 다시 보내기 409 | O |
| 다시 판정 3번째 | 거절 | `retry_limit` (테스트) | O |
| 슬랙 오류 | `send_failed` 로 남기고 다시 보낼 수 있다 | 실제로 `messages_tab_disabled` → resend 로 발송 | O |
| 네트워크 실패 | 버튼이 잠기지 않는다 | 브라우저에서 확인 (D44) | O |

## 캡처 — 어디에 있나

| 무엇 | 어디에 |
|---|---|
| **발행 게이트** — 대기 목록 · 승인 구역 · 관련 카드 · 수정/삭제 · 결정 기록 · 자동 발행 · 실제 슬랙 발송 | [`evidence/hitl/`](./evidence/hitl/) 13장 (`README.md` 에 각 캡처의 실행 출처) |
| live 브리핑 · 발행 게이트 실행 기록 | `runs/` (gitignore — 로컬에만). 합성 픽스처 실행의 카드 · 도구 기록만 `fixtures/publish-gate/` 에 복사해 두었다 (실제 데이터 실행은 넣지 않았다 — D46) |

Claude Code 에서 MCP 서버가 붙는 화면은 캡처하지 않았다 — `.mcp.json` 과 `/mcp` 로 확인한다 (위 「실행」).
