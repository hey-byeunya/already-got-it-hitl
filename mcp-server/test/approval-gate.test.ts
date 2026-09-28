/**
 * 검사: 승인 게이트가 실제로 막는가 (DECISIONS.md D14 ②)
 *
 * 발단: Agent SDK 문서가 "자동 승인된 도구는 canUseTool 에 도달하지 않는다"고 경고한다.
 * 클라이언트 설정 한 줄로 게이트가 무력화될 수 있으므로, 서버가 스스로 막는지 확인한다.
 *
 * 경계도 함께 본다 — 유효한 승인은 통과해야 한다. 다 막으면 게이트가 아니라 벽이다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempRuns } from './helpers.js';
import * as approvals from '../src/approvals.js';
import * as runlog from '../src/runlog.js';

test('승인 게이트', async (t) => {

  t.test('토큰이 없으면 approval_required 로 거절한다', () => {
    withTempRuns(() => {
      runlog.openRun('r1', 'f1-normal');
      assert.throws(
        () => approvals.consume('r1', undefined, 'create_github_issue', 'owner/repo'),
        (e: any) => e.code === 'approval_required',
      );
    });
  });

  t.test('없는 토큰도 거절한다', async () => {
    withTempRuns(() => {
      runlog.openRun('r1', 'f1-normal');
      assert.throws(
        () => approvals.consume('r1', 'apr_아무거나', 'create_github_issue', 'owner/repo'),
        (e: any) => e.code === 'approval_required',
      );
    });
  });

  t.test('같은 토큰을 두 번 쓰면 token_already_used — 두 번 실행되지 않는다', async () => {
    withTempRuns(() => {
      runlog.openRun('r1', 'f1-normal');
      const t1 = approvals.issueToken('r1', 'create_github_issue', 'owner/repo', 600);
      approvals.consume('r1', t1.token, 'create_github_issue', 'owner/repo'); // 1회차 성공
      assert.throws(
        () => approvals.consume('r1', t1.token, 'create_github_issue', 'owner/repo'),
        (e: any) => e.code === 'token_already_used',
      );
    });
  });

  t.test('만료된 토큰은 approval_expired', async () => {
    withTempRuns(() => {
      runlog.openRun('r1', 'f1-normal');
      const t1 = approvals.issueToken('r1', 'create_github_issue', 'owner/repo', -1); // 이미 만료
      assert.throws(
        () => approvals.consume('r1', t1.token, 'create_github_issue', 'owner/repo'),
        (e: any) => e.code === 'approval_expired',
      );
    });
  });

  t.test('다른 도구·다른 대상의 토큰은 approval_scope_mismatch', async () => {
    withTempRuns(() => {
      runlog.openRun('r1', 'f1-normal');
      const forRevert = approvals.issueToken('r1', 'revert_issue', '9001', 600);
      assert.throws(
        () => approvals.consume('r1', forRevert.token, 'create_github_issue', 'owner/repo'),
        (e: any) => e.code === 'approval_scope_mismatch',
      );

      const forOtherRepo = approvals.issueToken('r1', 'create_github_issue', 'other/repo', 600);
      assert.throws(
        () => approvals.consume('r1', forOtherRepo.token, 'create_github_issue', 'owner/repo'),
        (e: any) => e.code === 'approval_scope_mismatch',
      );
    });
  });

  // ── 경계: 막으면 안 되는 것 ──────────────────────────────────
  t.test('경계 — 유효한 승인은 통과한다', async () => {
    withTempRuns(() => {
      runlog.openRun('r1', 'f1-normal');
      const t1 = approvals.issueToken('r1', 'create_github_issue', 'owner/repo', 600);
      const used = approvals.consume('r1', t1.token, 'create_github_issue', 'owner/repo');
      assert.equal(used.token, t1.token);
      assert.ok(used.used_at, '사용 시각이 기록돼야 한다');
    });
  });

  t.test('경계 — 실행이 다르면 토큰도 섞이지 않는다', async () => {
    withTempRuns(() => {
      runlog.openRun('r1', 'f1-normal');
      runlog.openRun('r2', 'f1-normal');
      const t1 = approvals.issueToken('r1', 'create_github_issue', 'owner/repo', 600);
      assert.throws(
        () => approvals.consume('r2', t1.token, 'create_github_issue', 'owner/repo'),
        (e: any) => e.code === 'approval_required',
        'r1 의 토큰이 r2 에서 통해서는 안 된다',
      );
    });
  });

  // 관측한 문제: 승인 기록·실행 기록이 깨지면 JSON.parse 가 그대로 터져
  // unexpected_error·크래시로 갔다. 깨진 파일로 승인 판정을 내리지 않는다.
  t.test('깨진 approvals.json 은 approvals_corrupted 로 거절한다', async () => {
    withTempRuns((runsDir) => {
      runlog.openRun('r-broken', 'f1-normal');
      writeFileSync(join(runsDir, 'r-broken', 'approvals.json'), '{깨진 파일');
      assert.throws(
        () => approvals.consume('r-broken', 'apr_아무거나', 'create_github_issue', 'owner/repo'),
        (e: any) => e.code === 'approvals_corrupted',
      );
    });
  });

  t.test('깨진 toolcalls.jsonl 은 toolcalls_corrupted 로 거절한다', async () => {
    withTempRuns((runsDir) => {
      runlog.openRun('r-broken2', 'f1-normal');
      appendFileSync(join(runsDir, 'r-broken2', 'toolcalls.jsonl'), '{깨진 줄}\n');
      assert.throws(
        () => runlog.readCalls('r-broken2'),
        (e: any) => e.code === 'toolcalls_corrupted',
      );
    });
  });
});
