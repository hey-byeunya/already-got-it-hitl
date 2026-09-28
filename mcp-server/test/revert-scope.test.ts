/**
 * 검사: revert_issue 가 임의의 이슈를 닫을 수 없는가 (확장② · 권한 최소화)
 *
 * 발단: 되돌리기 도구에 이슈 번호를 그대로 받으면, 승인만 통과하면 저장소의 아무 이슈나
 * 닫을 수 있게 된다. 되돌리기가 또 다른 사고가 되지 않도록 대상 범위를 승인 기록으로 제한한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTempRuns } from './helpers.js';
import * as approvals from '../src/approvals.js';
import * as runlog from '../src/runlog.js';

test('revert_issue 대상 범위', async (t) => {

  t.test('승인 기록이 비어 있으면 되돌릴 대상이 없다', async () => {
    withTempRuns(() => {
      runlog.openRun('r1', 'f1-normal');
      assert.deepEqual(approvals.createdIssueNumbers('r1'), []);
    });
  });

  t.test('이 실행이 만든 이슈만 범위에 든다', async () => {
    withTempRuns(() => {
      runlog.openRun('r1', 'f1-normal');
      runlog.openRun('r2', 'f1-normal');
      approvals.appendLog('r1', {
        at: new Date().toISOString(), tool: 'create_github_issue', target: 'o/r',
        created: { issue_number: 9001, repo: 'o/r' },
      });
      assert.deepEqual(approvals.createdIssueNumbers('r1'), [9001]);
      assert.deepEqual(approvals.createdIssueNumbers('r2'), [], '다른 실행의 이슈는 보이지 않아야 한다');
    });
  });

  t.test('되돌린 이슈는 두 번 되돌리지 않는다 (멱등)', async () => {
    withTempRuns(() => {
      runlog.openRun('r1', 'f1-normal');
      assert.equal(approvals.isAlreadyReverted('r1', 9001), false);
      approvals.appendLog('r1', {
        at: new Date().toISOString(), tool: 'revert_issue', target: '9001',
        reverted: { issue_number: 9001 },
      });
      assert.equal(approvals.isAlreadyReverted('r1', 9001), true);
    });
  });
});
