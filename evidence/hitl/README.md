# 발행 게이트 화면 캡처

2026-09-28, 로컬 개발 서버(`http://localhost:3011`, 픽스처 모드 · `PUBLISH_DRY_RUN=1`)에서 헤드리스 Chrome 1440px 폭으로 찍었다.

**재현 복사본에 대해** — 캡처할 때는 모든 실제 실행이 이미 사람의 답을 받은 뒤였다. 「답을 기다리는 화면」과 「수정·삭제 중인 화면」은
실제 실행의 폴더를 그대로 복사해 발행 기록만 지우고 다시 판정한 **재현본**(`repro-*`)으로 찍었다. 카드·도구 기록·실행 로그·사람이 답한 질문은
원래 실행 그대로다. 재현본은 캡처 뒤 대기 목록에서 치웠다.

| 파일 | 무엇 | 실행 |
|---|---|---|
| `hitl-01-publish-queue.png` | 발행 대기 목록 — 답할 건(NEEDS ANSWER)과 지나간 건(HANDLED), 걸린 기준, 현지 시각 | 목록 전체 (재현본 2편이 답할 건에 있다) |
| `hitl-02-run-overview.png` | 실행 화면 첫 화면 — 계기 3분할(30:35:35), 발행 게이트, 사람이 결정한 것 | `repro-f6-pending` ← `web-mukuixxr` (f6-error-creep) |
| `hitl-03-gate-pending.png` | 승인 구역 — WHY STOPPED · SIGNALS · EVIDENCE · SUMMARY · IF APPROVED, 네 가지 답 | `repro-f6-pending` — `errors_up` 로 멈춤 |
| `hitl-04-cards-related.png` | [ CARDS ] 의 관련 카드 강조 — `GATE · errors up` 딱지 | `repro-f6-pending` |
| `hitl-05-edit-remove.png` | edit & approve — 카드 자리에서 고치기, 3번 카드 remove (흐림 · 취소선 · REMOVED) | `repro-f5-remove` ← `web-mukubwty` (f5-metrics-down) |
| `hitl-06-edit-controls.png` | 수정 중인 승인 구역 — approve with edits · cancel | `repro-f5-remove` |
| `hitl-07-decided-edit.png` | 사람이 결정한 것 — 질문 답 · 이슈 거절(제목) · 수정 후 승인(고친 카드 제목) · 발송 | `web-mukspvze` (f3, 실제 기록) |
| `hitl-08-decided-retry.png` | 사람이 결정한 것 — 다시 판정(지시) 뒤 승인 | `web-mukslabb` (f2, 실제 기록) |
| `hitl-09-auto-published.png` | 기준 통과 · 사람을 거치지 않고 자동 발행(DRY_RUN) | `web-muksteqk` (f4 — D41 에서의 놓침 사례) |
| `hitl-10-home-link.png` | 홈 머리의 `[ PUBLISH ] waiting N` 링크 | 홈 |
| `hitl-11-slack-sent-approved.png` | **슬랙 실제 발송** — 사람이 approve → sent (`dry_run: false`) | `slack-test-f6` ← f6 복사본 |
| `hitl-12-slack-sent-auto.png` | **슬랙 실제 발송** — 기준 통과 · 자동 (첫 시도 실패 뒤 resend) | `slack-test-0921` ← 실제 09-21 주 복사본 |
| `hitl-13-slack-channel.png` | **슬랙 채널에 도착한 메시지** — `#ops-brief`, 🔴/🟡/🔵 카드 + 근거 줄 (사용자 캡처, 채널 영역만 잘라 둠) | `slack-test-f6` (사람 승인 경로) |

다시 찍으려면: 개발 서버를 띄운 뒤 캡처 스크립트(헤드리스 Chrome · DevTools 프로토콜)를 돌린다. 스크립트는 저장소 밖(작업용 폴더)에 두었다.

`hitl-13` 만 사용자가 슬랙 앱에서 직접 찍은 것이다. 공개 저장소에 올라가므로 왼쪽 사이드바(워크스페이스 목록·프로필)와 입력창은 잘라 냈다.
