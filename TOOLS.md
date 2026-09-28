# TOOLS — 도구 9개

도구는 `mcp-server/`에 **독립 stdio MCP 서버**로 한 번만 구현하고, 앱은 Agent SDK의 `mcpServers`
옵션으로, Claude Code는 `.mcp.json`으로 같은 서버를 붙여 쓴다 (`DECISIONS.md` D13).

| 도구 | 외부 호출 | 쓰기 | 권한 범위 | 삭제 | 승인 |
|---|---|---|---|---|---|
| `get_system_health` | Vercel REST API | ❌ | 해당 프로젝트만 | ❌ | — |
| `get_user_metrics` | Supabase RPC | ❌ | **집계값만** | ❌ | — |
| `get_dev_activity` | GitHub API | ❌ | 본인 저장소만 | ❌ | — |
| `web_search` | 검색 | ❌ | — | ❌ | — |
| `render_chart` | ❌ (앱 내부) | ❌ | — | ❌ | — |
| `compose_card` | ❌ (앱 내부) | ❌ | `runs/{run_id}/` 아래만 쓰기 | ❌ | — |
| `export_cardnews` | ❌ (앱 내부) | ❌ | `runs/{run_id}/` 아래만 읽기·쓰기 | ❌ | — |
| `create_github_issue` | GitHub API | ✅ | issue 생성만 | ❌ | **필수** |
| `revert_issue` | GitHub API | ✅ | **승인 기록에 있는 이슈만** 닫기 | ❌ | **필수** |

- 어떤 도구에도 Supabase `service_role` 키를 주지 않는다. 집계는 `security definer` RPC로만 접근한다.
- **삭제 권한은 어떤 도구에도 없다.** `revert_issue`는 되돌릴 수 있는 상태 변경(이슈 닫기)만 한다.
- 쓰기 도구는 에이전트가 직접 실행하지 못한다. **제안 → 사람 승인 → 실행.**
- Agent SDK 내장 도구(`Bash`·`Write`·`Edit`·`Read`·`Glob`·`Grep`)는 `disallowedTools`로 차단한다.
- **description에 쓴 제약과 함수의 실제 검사는 같은 계약이다.** 설명만 고치고 검사를 안 고치면
  설명은 아무것도 제한하지 못한다. 둘을 같이 고친다.

## 쓰기 도구의 승인 게이트 (D14)

`create_github_issue`와 `revert_issue`에는 서버가 두 가지를 직접 붙인다.

1. **`_meta["anthropic/requiresUserInteraction"]` 선언** — 이게 붙으면 allow 규칙이 매치돼도
   항상 `canUseTool` 콜백으로 떨어진다. 게이트가 앱 설정이 아니라 **도구의 성질**이 된다.
2. **`approval_token` 검사** — 유효한 1회용 토큰 없이는 서버가 거절한다. 앱을 우회해 서버에
   직접 붙어도 막힌다.

토큰 규약: 앱이 사람의 승인을 받은 뒤 발급하고, 대상 도구·대상 리소스·만료 시각을 함께 기록한다.
한 번 쓰면 소멸한다. 서버는 어긋난 경우를 코드로 구분한다 (`API_SPEC.md` 승인 토큰 규약과 동일).

| 상황 | 서버 응답 |
|---|---|
| 토큰 없음 | `approval_required` |
| 만료됨 | `approval_expired` |
| 다른 도구·다른 대상 | `approval_scope_mismatch` |
| 이미 사용됨 | `token_already_used` — **두 번 실행하지 않는다** |

## 오류 규약

오류는 예외로 던지지 않고 **도구 결과로 모델에게 되돌린다.** 작업 전체를 죽이지 않기 위해서다.

```json
{ "error": "<코드>", "message": "<사람과 모델이 읽을 설명>", "...회복 정보": "..." }
```

`error` 코드는 프로그램용, `message`는 사람·모델용이다. 가능하면 **회복 정보를 함께 실어 보낸다** —
무엇이 있었는지, 가장 가까운 유효한 값이 무엇인지.

---

## 1. `get_system_health`

> 「이미 있어」의 배포와 실행 상태를 가져온다. 시스템이 이번 기간에 문제가 없었는지 확인할 때
> 가장 먼저 호출한다. 배포 성공/실패, 빌드 상태, 함수 오류를 돌려준다.
> **시스템 상태를 추측하지 말고 반드시 이 도구로 확인한다.**

```json
// 입력
{ "since": "2026-09-02T00:00:00+09:00", "until": "2026-09-09T00:00:00+09:00" }

// 출력
{ "period": { "since": "...", "until": "...", "tz": "Asia/Seoul" },
  "deployments": [
    { "id": "dpl_...", "created_at": "2026-09-05T14:20:00+09:00",
      "state": "ERROR", "target": "production", "commit_sha": "a1b2c3d",
      "build_error": "Type error in app/page.tsx",
      "url": "https://already-got-....vercel.app",
      "commit_url": "https://github.com/hey-byeunya/already-got-it/commit/a1b2c3d..." }
  ],
  "summary": { "total": 7, "ready": 6, "error": 1 },
  "function_errors": { "count": 12, "window": "7d", "available": true },
  "unavailable_fields": [] }
```

- `unavailable_fields`는 **플랜이나 권한 때문에 읽지 못한 항목**을 담는다. 빈 값을 0으로 내리지 않는다.
- live에서 배포 `id`·`created_at`을 모르면 `null`이다. `'(id 없음)'` 같은 자리 문자열을 넣지 않는다 —
  모델이 사실로 읽는다. `commit_sha`·`build_error`도 모르면 `null`이다.
- 목록이 100건으로 꽉 차면 `truncated: true`가 붙는다. 그 뒤는 잘렸을 수 있으므로
  합계를 정확한 전체로 서술하지 않는다.
- **실패 규칙**: 인증 실패 → 즉시 중단, 토큰 확인 안내. 조회 실패 → 1회 재시도, 그래도 실패하면
  이 축을 `확인 못 함`으로 표시하고 나머지 축으로 계속한다(대체 경로 있음).
- **빈 결과**: 기간 내 배포가 없는 것은 오류가 아니다. "배포 없음"도 브리핑할 가치가 있는 사실이다.
- 날짜만 온 `until`("2026-09-10")은 **그 날 끝까지 포함**한다. 그대로 자정으로 읽으면
  당일 배포가 통째로 빠져 "배포 0건"이 된다.
- 배포마다 찾아갈 링크(`url`·`commit_url`)가 있다. 빌드 에러를 이슈·카드에 적을 때 함께 쓴다.
  모르면 `null`이다.

## 2. `get_user_metrics`

> 「이미 있어」 사용자 활동의 **집계 지표**를 가져온다. 가입 추이, 있템·위시 등록 수, 활성 사용자
> 같은 숫자를 기간별로 돌려준다. **개별 사용자나 개별 물건은 조회할 수 없다** — 이 도구는 집계값만
> 반환하며, 원시 행이 필요한 요청은 거절한다.

```json
// 입력
{ "since": "2026-09-02", "until": "2026-09-09", "granularity": "day" }

// 출력
{ "period": { "since": "...", "until": "..." },
  "series": [ { "date": "2026-09-02", "signups": 3, "owned_created": 41, "wish_created": 12,
                "active_users": 18, "errors": 0 } ],
  "totals": { "signups": 14, "owned_created": 260, "wish_created": 77, "active_users": 42,
              "errors_total": 6 },
  "previous_period_totals": { "signups": 21, "owned_created": 310, "wish_created": 95,
                              "active_users": 55, "errors_total": 1 },
  "errors_by_route": [ { "route": "/items/[id]", "count": 4,
                         "url": "https://already-got-it.vercel.app/items/[id]" } ],
  "unavailable_fields": [] }
```

- `previous_period_totals`는 **추이 판단의 근거**다. 이번 기간 숫자만으로는 늘었는지 줄었는지 알 수 없다.
- 개인정보는 반환하지 않는다. 이메일·사용자 ID·물건 이름이 출력에 없다.
  에러 로그도 마찬가지다 — `message`·`user_id`는 절대 내보내지 않고 route 이름과 건수만 본다.
- `errors_by_route`는 그 기간 에러가 많은 route 상위 5개다. `지금 손봐야 할 것` 카드의 근거가 된다.
  페이지 route 에는 찾아갈 `url`이 붙는다. `action:` 접두 Server Action 에는 페이지가 없어 `null`이다.
- `error_logs` 테이블이 없는 DB에서는 에러 지표가 `null`이고 `unavailable_fields`에
  `"error_logs"`가 들어간다. 0으로 채우지 않는다 — 모르는 것과 0은 다르다.
- **실패 규칙**: RPC 실패 → 1회 재시도 후 이 축을 `확인 못 함`으로. 인증 실패 → 즉시 중단.
- **빈 결과**: 신규 데이터가 없으면 0으로 채운 series를 돌려준다. 이건 실제 0이므로 결측과 다르다.
- 날짜만 온 `until`은 **그 날 끝까지 포함**한다 (RPC에 하루 더한 날짜를 넘긴다).

## 3. `get_dev_activity`

> 저장소의 개발 활동을 가져온다. 열린 이슈, 기간 내 커밋, PR 상태를 돌려준다.
> 무엇이 쌓이고 있고 무엇이 멈춰 있는지 판단할 때 호출한다.
> **이슈를 만들거나 닫지는 않는다** — 그건 `create_github_issue`와 `revert_issue`의 일이다.

```json
// 입력
{ "repo": "hey-byeunya/already-got-it", "since": "2026-09-02", "until": "2026-09-09" }

// 출력
{ "open_issues": [ { "number": 12, "title": "...", "created_at": "...", "age_days": 23,
                     "labels": ["bug"] } ],
  "commits": { "count": 18, "authors": 1 },
  "pull_requests": [ { "number": 15, "state": "open", "age_days": 6, "draft": false } ],
  "summary": { "open_issue_count": 5, "oldest_open_issue_days": 23, "merged_this_period": 2 } }
```

- **실패 규칙**: 인증 실패 → 즉시 중단. 레이트 리밋 → 남은 시간과 함께 `rate_limited` 반환,
  이 축을 `확인 못 함`으로. 저장소 없음 → 즉시 중단(설정 오류다).
- 허용된 저장소 목록 밖의 `repo`는 거절한다(`repo_not_allowed`).
- 목록이 페이지 상한에 꽉 차면 `truncated: true`가 붙는다. 잘린 수를 정확한 합계로 서술하지 않는다.
- 날짜만 온 `until`은 **그 날 끝까지 포함**한다. 그대로 쓰면 당일 병합이 빠진다.

## 4. `web_search`

> 이 앱이 실제로 쓰는 의존성의 릴리스 노트나 보안 권고를 찾을 때만 호출한다.
> 시스템 상태나 사용자 지표를 알아내는 용도로는 쓰지 않는다 — 그건 앞의 세 도구의 일이다.
> **검색 결과 요약만으로 카드의 핵심 사실을 확정하지 않는다.**

```json
// 입력
{ "query": "Next.js 16.2 security advisory", "max_results": 5 }

// 출력
{ "results": [ { "title": "...", "url": "...", "snippet": "...", "published_at": "2026-09-04" } ] }
```

- **실패 규칙**: 검색 실패 → 1회 재시도. 그래도 실패하면 트렌드 축을 비우고 나머지로 계속한다.
- 게시일을 확인할 수 없는 결과는 `published_at: null`로 두고, 카드에서 **미확인**으로 표시한다.

## 5. `render_chart`

> 앞선 조회 도구가 돌려준 값으로 카드에 넣을 SVG 차트를 그린다.
> **`source` 필드가 필수다** — 어느 도구의 어느 값을 그리는지 밝혀야 한다.
> 직접 입력한 수치나 기억한 수치로는 차트를 그릴 수 없다.

```json
// 입력
{ "card_no": 2, "chart_type": "bar",
  "source": { "tool": "get_user_metrics", "field": "series[].signups", "run_step": 3 },
  "data": [ { "label": "09-02", "value": 3 } ],
  "title": "일별 가입", "highlight": { "label": "09-06", "note": "최저" } }

// 출력
{ "card_no": 2, "svg_path": "runs/{run_id}/charts/02.svg", "bytes": 4120,
  "rendered_ok": true, "source_verified": true }
```

- **`source_verified`가 true여야 완료다.** 서버는 `source`가 가리키는 도구 호출이 이 실행의 기록에
  실제로 있고, `data`의 값이 그 결과와 일치하는지 대조한다. 어긋나면 `source_mismatch`로 거절한다.
- **`rendered_ok`가 true여야 완료다.** 파일이 생기고 유효한 SVG로 열리는 것까지 확인한다.
  응답 문장만으로 성공을 판단하지 않는다.
- 쓰기 경로는 `runs/{run_id}/` 아래로 제한한다.
- **실패 규칙**: 해당 카드에만 오류와 재시도 버튼을 붙인다. 승인된 스토리보드와 다른 카드 결과는
  유지한다. 3회 실패하면 그 카드를 차트 없이 진행할지 묻는다.

## 6. `compose_card`

> 카드 한 장을 만든다. 제목·본문·출처가 **각각 별도 텍스트 레이어**로 들어가고,
> 같은 내용이 데이터로도 저장돼 나중에 한 장만 고칠 수 있다.
> `chart_path`에 `render_chart`가 만든 경로를 주면 그 파일을 **읽어서** 끼워 넣는다 —
> 차트를 다시 그리지 않으므로 텍스트만 고칠 때 그림이 바뀌지 않는다.
> `sources`는 비울 수 없다. 어느 도구의 어느 값에서 온 문장인지 적는다.
> 글자가 상자에 들어가지 않으면 잘라서 그리지 않고 `text_overflow`로 거절한다.

```json
// 입력
{ "card_no": 2, "kind": "metric", "category": "watch", "title": "...", "body": ["..."],
  "sources": ["get_user_metrics · totals"], "chart_path": "charts/02.svg" }

// 출력
{ "card_no": 2, "svg_path": "cards/02.svg", "json_path": "cards/02.json",
  "rendered_ok": true, "chart_embedded": true, "chart_rerendered": false,
  "sources_verified": [{ "tool": "get_user_metrics", "field": "totals" }],
  "cover_source": null }
```

- 표지(`kind: "cover"`)의 삽화는 agy로 미리 만들어 둔 것(`assets/cover.svg`)이 있으면
  그것을 쓰고, 없으면 로컬 SVG로 그린다. 어느 쪽인지는 `cover_source`
  (`agy-asset`·`local-svg`)로 밝힌다. `cover`가 아니면 `null`이다.
- `chart_path`는 `render_chart`가 돌려준 `charts/NN.svg` 형태만 받는다. 임의 경로는
  `chart_path_not_allowed`로, 없는 파일은 `chart_not_found`로 거절한다.
- `title`은 **한 줄 문자열**이다. `["a", "b"]` 같은 배열 문자열이 오면 대괄호·따옴표를
  벗겨 `a, b` 로 그린다. 파싱에 실패하면 원문을 둔다 — 제목을 버리지 않는다.
- **실패 규칙**: 같은 `card_no`로 다시 부르면 그 카드만 덮어쓴다. 다른 카드 결과는 유지한다.
- `sources` 각 행은 `"도구 · 필드"` 형식이다. cover가 아닌 카드는 각 행이 이번 실행의
  실제 호출·값을 가리키는지 대조하고, 어긋나면 `source_shape_invalid`·`source_not_found`·
  `source_field_empty`로 거절한다. 존재 여부까지만 본다 — 값이 문장 내용과 의미상
  이어지는지는 사람이 검수에서 본다 (`EVAL.md` 근거 미표기율은 수동 지표).
  cover(표지)는 요약 성격이라 빈 것만 본다.
- `category`는 cover가 아니면 **필수**다: `fix_now`(지금 손봐야 할 것) · `watch`(지켜볼 것) ·
  `fyi`(알아둘 것). 카드 색(`accent`)은 이 값에서 정해진다 — `fix_now→bad`, `watch→warn`,
  `fyi→accent`. 모델이 `accent`를 넘겨도 쓰지 않는다. 빠지면 `category_required`,
  제목·본문에 적은 분류 이름이 `category`와 다르면 `category_text_mismatch`로 거절한다.
  이 칸이 생기기 전에 만든 카드(분류 없음)는 화면·발행 게이트가 색으로 본다 (`DECISIONS.md` D40).

## 7. `export_cardnews`

> 만든 카드들을 PNG로 굽고 ZIP 한 개로 묶는다. 출처 기록(`SOURCES.md`)도 함께 넣는다.
> 카드를 새로 만들지 않는다 — `compose_card`로 만든 것만 내보낸다.

```json
// 입력
{ "note": "이번 주 브리핑" }

// 출력
{ "zip_path": "cardnews-{run_id}.zip", "cards": 6,
  "entries": ["cards/01.png", "…", "SOURCES.md"], "opened_ok": true }
```

- 번호가 1부터 빠짐없이 이어지지 않으면 `card_numbers_not_contiguous`로 거절한다.
- PNG 머리를 직접 읽어 크기를 대조하고, `opened_ok`가 false인 카드가 있으면
  `export_incomplete`로 거절한다 — 그때는 ZIP을 만들지 않는다.
- **실패 규칙**: `unzip -l`·`unzip -t`로 순서·수량·온전함을 직접 확인한다.

## 8. `create_github_issue` ⚠️ 쓰기

> 브리핑에서 발견한 문제를 저장소 이슈로 남긴다. 사용자가 카드에서 "이건 이슈로 남기자"를
> 승인했을 때만 호출된다. **에이전트는 이 도구를 직접 실행하지 않는다** — 제안만 만들고
> 승인을 기다린다. 이슈 본문에는 근거가 된 도구와 값을 함께 적는다.

```json
// 입력
{ "repo": "hey-byeunya/already-got-it", "title": "...", "body": "...",
  "labels": ["ops"], "source": { "tool": "get_system_health", "field": "deployments[0]" },
  "approval_token": "..." }

// 출력
{ "number": 31, "url": "https://github.com/...", "created": true }
```

- `_meta["anthropic/requiresUserInteraction"]` 선언 → allow 규칙이 있어도 항상 승인 콜백으로 떨어진다.
- **`approval_token` 검사는 서버가 한다.** 없으면 `approval_required`, 만료됐으면
  `approval_expired`, 다른 도구·대상이면 `approval_scope_mismatch`로 거절한다.
  앱을 우회해도 막힌다.
- `labels`는 허용 목록 안에서만. 임의 라벨을 만들지 않는다.
- 생성한 이슈 번호는 **이 실행의 승인 기록에 저장**된다. `revert_issue`의 대상 범위가 된다.
- **실패 규칙**: 레이트 리밋 → 사람에게 알리고 대기. 권한 부족 → 즉시 중단하고 PAT 범위 안내.
  중복 제출(같은 토큰 재사용) → `token_already_used`로 거절하고 **이슈를 두 번 만들지 않는다.**

## 9. `revert_issue` ⚠️ 쓰기 (확장)

> 이 실행이 승인 기록으로 만든 이슈를 닫아 되돌린다. **승인 기록에 없는 이슈 번호는 거절한다** —
> 이 도구로는 임의의 이슈를 닫을 수 없다. 삭제는 하지 않고 닫기만 한다.

```json
// 입력
{ "issue_number": 31, "reason": "오탐이었음", "approval_token": "..." }

// 출력
{ "number": 31, "state": "closed", "reverted": true }
```

- **대상 제한**: 이 실행의 승인 기록에 있는 이슈만. 그 밖은 `not_in_approval_log`로 거절한다.
- `_meta["anthropic/requiresUserInteraction"]` + `approval_token` 둘 다 적용된다. 취소도 승인을 받는다.
- 되돌린 사실은 실행 기록에 남는다. 조용히 사라지지 않는다.
- **실패 규칙**: 이미 닫힌 이슈 → `already_closed`로 성공 처리(멱등). 권한 부족 → 즉시 중단.

---

## 도구 실패를 어떻게 다루는지 요약

| 실패 | 처리 | 대체 경로 |
|---|---|---|
| 인증 실패 (모든 도구) | **즉시 중단** + 무엇을 확인할지 안내 | 없음 |
| 조회 실패 (읽기 도구) | 1회 재시도 → 그 축을 `확인 못 함`으로 | 있음 — 나머지 축으로 계속 |
| 레이트 리밋 | 남은 시간과 함께 반환 | 있음 (읽기) / 대기 (쓰기) |
| `render_chart` 실패 | 그 카드만 오류 + 재시도. 3회 후 차트 없이 진행 여부 확인 | 있음 |
| `source` 불일치 | `source_mismatch`로 거절. **지어낸 수치로 차트를 그리지 않는다** | 없음 — 조회부터 다시 |
| `compose_card` 근거 불일치 | `source_shape_invalid`·`source_not_found`·`source_field_empty`로 거절. **없는 근거로 카드를 만들지 않는다** (cover 제외) | 없음 — 조회부터 다시 |
| `compose_card` 실패 | `text_overflow`·`chart_not_found` 등. 문안을 줄이거나 차트부터 만든다 | 있음 — 그 카드만 다시 |
| `compose_card` 분류 | `category_required`·`category_text_mismatch`. 분류를 주거나 글의 분류 이름을 맞춘다 | 있음 — 그 카드만 다시 |
| `export_cardnews` 실패 | `export_incomplete`·`card_numbers_not_contiguous`. ZIP을 만들지 않는다 | 없음 — 카드부터 다시 |
| 승인 토큰 없음 | `approval_required`로 거절 | 없음 — 승인부터 |
| 승인 토큰 만료·대상 어긋남 | `approval_expired`·`approval_scope_mismatch`로 거절 | 없음 — 다시 승인부터 |
| 승인 토큰 재사용 | `token_already_used`로 거절. **두 번 실행하지 않는다** | 없음 |
