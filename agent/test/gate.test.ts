/**
 * 검사: canUseTool 게이트 (DECISIONS.md D14)
 *
 * 확인하는 것
 *   - 쓰기 도구는 **기본 거절**이다. 승인 없이 통과하지 않는다
 *   - 승인하면 approval_token 을 updatedInput 으로 주입한다 → 모델은 토큰을 받지 않는다
 *   - AskUserQuestion 은 답을 updatedInput.answers 로 되돌린다
 *   - 허용 목록에 없는 도구는 거절한다 (fail-closed)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGate, approvalTarget, type Decider, type QuestionSpec } from '../src/gate.js';
import { LimitTracker } from '../src/limits.js';
import { WRITE_TOOLS, READ_TOOLS } from '../src/tools.js';

const ISSUE_TOOL = WRITE_TOOLS[0]!;   // mcp__ops__create_github_issue
const REVERT_TOOL = WRITE_TOOLS[1]!;  // mcp__ops__revert_issue

/**
 * 일회용 runs 폴더를 준다.
 *
 * **await 를 반드시 붙인다.** 동기 함수로 두고 async 콜백을 넘기면
 * 본문이 끝나기 전에 finally 가 폴더를 지워, 파일이 없다고 나온다.
 * (실제로 그렇게 만들었다가 검사 하나가 엉뚱한 이유로 실패했다.)
 */
async function tempRuns<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'ops-agent-'));
  const prev = process.env.OPS_RUNS_DIR;
  process.env.OPS_RUNS_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.OPS_RUNS_DIR; else process.env.OPS_RUNS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

const denyAll: Decider = {
  async answerQuestions() { return null; },
  async approveWrite() { return { approved: false, reason: '검사에서 거절' }; },
};
const allowAll: Decider = {
  async answerQuestions(qs: QuestionSpec[]) {
    return Object.fromEntries(qs.map((q) => [q.question, q.options[0]!.label]));
  },
  async approveWrite() { return { approved: true }; },
};

const mkGate = (decider: Decider) => createGate({
  runId: 'r1', decider, limits: new LimitTracker(), approvalTtlSeconds: 600,
});

test('승인 게이트 (canUseTool)', async (t) => {
  await t.test('쓰기 도구는 기본 거절이다', async () => {
    await tempRuns(async () => {
      const gate = mkGate(denyAll);
      const res = await gate(ISSUE_TOOL, { repo: 'o/r', title: 't', body: 'b' }, {} as never);
      assert.equal(res?.behavior, 'deny');
      assert.match((res as { message: string }).message, /승인/);
    });
  });

  await t.test('승인하면 approval_token 을 주입한다 — 모델은 토큰을 받지 않는다', async () => {
    await tempRuns(async (dir) => {
      const gate = mkGate(allowAll);
      const input = { repo: 'o/r', title: 't', body: 'b' };
      const res = await gate(ISSUE_TOOL, input, {} as never);
      assert.equal(res?.behavior, 'allow');
      const updated = (res as { updatedInput?: Record<string, unknown> }).updatedInput!;
      assert.ok(typeof updated.approval_token === 'string' && updated.approval_token.startsWith('apr_'),
        '승인 결과에 토큰이 실려야 한다');
      assert.equal(input.hasOwnProperty('approval_token'), false,
        '원래 입력(모델이 보낸 것)에는 토큰이 없어야 한다');

      // 토큰이 실제로 저장돼 MCP 서버가 검사할 수 있어야 한다.
      const store = join(dir, 'r1', 'approvals.json');
      assert.ok(existsSync(store));
      const parsed = JSON.parse(readFileSync(store, 'utf8'));
      assert.equal(parsed.tokens.length, 1);
      assert.equal(parsed.tokens[0].tool, 'create_github_issue');
      assert.equal(parsed.tokens[0].target, 'o/r');
    });
  });

  await t.test('승인 대상을 입력에서 찾을 수 없으면 거절한다', async () => {
    await tempRuns(async () => {
      const gate = mkGate(allowAll);
      const res = await gate(ISSUE_TOOL, { title: 't' }, {} as never); // repo 없음
      assert.equal(res?.behavior, 'deny');
      assert.match((res as { message: string }).message, /승인 대상/);
    });
  });

  await t.test('AskUserQuestion 은 답을 updatedInput.answers 로 되돌린다', async () => {
    await tempRuns(async () => {
      const gate = mkGate(allowAll);
      const questions: QuestionSpec[] = [{
        question: '어느 축을 깊게 볼까요?', header: '축',
        options: [{ label: '시스템', description: '' }, { label: '사용자', description: '' }],
      }];
      const res = await gate('AskUserQuestion', { questions }, {} as never);
      assert.equal(res?.behavior, 'allow');
      const updated = (res as { updatedInput?: Record<string, unknown> }).updatedInput!;
      assert.deepEqual(updated.answers, { '어느 축을 깊게 볼까요?': '시스템' });
      assert.deepEqual(updated.questions, questions, '원래 질문도 함께 되돌려야 한다');
    });
  });

  await t.test('답하지 않으면 거절한다 — 답 없이 다음 단계로 넘어가지 않는다', async () => {
    await tempRuns(async () => {
      const gate = mkGate(denyAll);
      const res = await gate('AskUserQuestion', { questions: [] }, {} as never);
      assert.equal(res?.behavior, 'deny');
    });
  });

  await t.test('허용 목록에 없는 도구는 거절한다 (fail-closed)', async () => {
    await tempRuns(async () => {
      const gate = mkGate(allowAll);
      for (const tool of ['Bash', 'Write', 'mcp__other__do_thing']) {
        const res = await gate(tool, {}, {} as never);
        assert.equal(res?.behavior, 'deny', `${tool} 은 거절돼야 한다`);
      }
    });
  });

  await t.test('되돌리기의 승인 대상은 이슈 번호다', () => {
    assert.equal(approvalTarget(REVERT_TOOL, { issue_number: 9001 }), '9001');
    assert.equal(approvalTarget(ISSUE_TOOL, { repo: 'o/r' }), 'o/r');
  });

  // ── 경계 ────────────────────────────────────────────────────
  await t.test('경계 — 읽기 도구는 allowedTools 에 있어 게이트로 오지 않는다', () => {
    assert.equal(READ_TOOLS.length, 7, '조회 4 + 차트 1 + 카드 2');
    for (const t2 of READ_TOOLS) {
      assert.equal(WRITE_TOOLS.includes(t2), false, `${t2} 가 쓰기 목록에 있으면 안 된다`);
    }
  });

  await t.test('경계 — 쓰기 도구는 allowedTools 에 절대 들어가지 않는다', () => {
    for (const w of WRITE_TOOLS) {
      assert.equal(READ_TOOLS.includes(w), false,
        `${w} 가 allowedTools 에 들어가면 canUseTool 이 건너뛰어져 게이트가 무력화된다`);
    }
  });
});
