/**
 * 검사: PreToolUse 훅 (DECISIONS.md D14 ③)
 *
 * 이 훅은 모든 단계보다 먼저 돌고 bypassPermissions 에서도 deny 가 유효하다.
 * 그래서 **설정이 어떻든 참이어야 하는 불변식**만 검사한다.
 *
 * 경계가 특히 중요하다 — 훅이 과하면 사람이 묻기도 전에 모든 쓰기가 막힌다.
 * 실제로 "승인 기록이 있는지"를 훅에서 검사하려다 그 함정을 발견해 설계에서 뺐다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreToolUseHook, evaluate, ALLOWED_TOOL_NAMES } from '../src/hook.js';
import { READ_TOOLS, WRITE_TOOLS } from '../src/tools.js';

const ISSUE = WRITE_TOOLS[0]!;
const REVERT = WRITE_TOOLS[1]!;
const READ = READ_TOOLS[0]!;

/** 훅을 실제 콜백 형태로 불러 반환값 모양까지 확인한다. */
async function callHook(tool: string, input: unknown) {
  const seen: unknown[] = [];
  const hook = createPreToolUseHook((d) => seen.push(d));
  const out = await hook(
    { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'tu_1' } as never,
    'tu_1',
    { signal: new AbortController().signal },
  );
  return { out: out as Record<string, unknown>, seen };
}

test('PreToolUse 훅 — 허용 목록 밖 도구', async (t) => {
  await t.test('내장 도구는 거절한다 (설정이 어떻든)', async () => {
    for (const tool of ['Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'ToolSearch']) {
      const { out, seen } = await callHook(tool, {});
      const spec = out.hookSpecificOutput as Record<string, unknown>;
      assert.equal(spec?.permissionDecision, 'deny', `${tool} 은 거절돼야 한다`);
      assert.match(String(spec?.permissionDecisionReason), /허용하지 않은 도구/);
      assert.equal(seen.length, 1, '거절은 기록에 남아야 한다 — 조용히 막지 않는다');
    }
  });

  await t.test('다른 MCP 서버의 도구도 거절한다', async () => {
    const { out } = await callHook('mcp__somewhere__do_thing', {});
    assert.equal((out.hookSpecificOutput as Record<string, unknown>)?.permissionDecision, 'deny');
  });

  await t.test('경계 — 도메인 도구 9개와 AskUserQuestion 은 통과시킨다', async () => {
    for (const tool of ALLOWED_TOOL_NAMES) {
      const { out, seen } = await callHook(tool, { run_id: 'r1' });
      assert.equal(out.hookSpecificOutput, undefined, `${tool} 은 훅이 판단하지 않아야 한다`);
      assert.equal(out.continue, true);
      assert.equal(seen.length, 0);
    }
    assert.equal(ALLOWED_TOOL_NAMES.length, 10, '읽기 7 + 쓰기 2 + AskUserQuestion');
  });
});

test('PreToolUse 훅 — 토큰의 출처', async (t) => {
  await t.test('모델이 approval_token 을 넣어 보내면 거절한다', async () => {
    for (const tool of [ISSUE, REVERT]) {
      const { out, seen } = await callHook(tool, { run_id: 'r1', approval_token: 'apr_지어낸값' });
      const spec = out.hookSpecificOutput as Record<string, unknown>;
      assert.equal(spec?.permissionDecision, 'deny');
      assert.match(String(spec?.permissionDecisionReason), /모델이 스스로 넣을 수 없다/);
      assert.equal((seen[0] as { rule: string }).rule, 'model_supplied_approval_token');
    }
  });

  await t.test('값이 비어 있어도 키가 있으면 거절한다', async () => {
    const { out } = await callHook(ISSUE, { run_id: 'r1', approval_token: '' });
    assert.equal((out.hookSpecificOutput as Record<string, unknown>)?.permissionDecision, 'deny');
  });

  await t.test('경계 — 토큰이 없는 쓰기 호출은 통과시킨다 (승인 절차로 가야 한다)', async () => {
    // 여기서 막으면 사람이 묻기도 전에 모든 쓰기가 차단된다.
    // 훅은 canUseTool 보다 먼저 돌기 때문에 이 시점에는 아직 승인이 없다.
    const { out, seen } = await callHook(ISSUE, { run_id: 'r1', repo: 'o/r', title: 't', body: 'b' });
    assert.equal(out.hookSpecificOutput, undefined, '훅이 판단하지 않고 canUseTool 로 넘겨야 한다');
    assert.equal(seen.length, 0);
  });

  await t.test('경계 — 읽기 도구는 approval_token 검사 대상이 아니다', async () => {
    const { out } = await callHook(READ, { run_id: 'r1', approval_token: 'x' });
    assert.equal(out.hookSpecificOutput, undefined);
  });
});

test('PreToolUse 훅 — 판정 함수', async (t) => {
  await t.test('evaluate 는 통과할 때 null 을 돌려준다', () => {
    assert.equal(evaluate(READ, { run_id: 'r1' }), null);
    assert.equal(evaluate(ISSUE, { run_id: 'r1', repo: 'o/r' }), null);
    assert.equal(evaluate('AskUserQuestion', { questions: [] }), null);
  });

  await t.test('입력이 객체가 아니어도 터지지 않는다', () => {
    assert.equal(evaluate(ISSUE, null), null);
    assert.equal(evaluate(ISSUE, 'string'), null);
    assert.equal(evaluate(ISSUE, undefined), null);
  });

  await t.test('규칙 이름이 붙는다 (실행 로그에서 구분하기 위해)', () => {
    assert.equal(evaluate('Bash', {})?.rule, 'tool_not_allowed');
    assert.equal(evaluate(ISSUE, { approval_token: 'x' })?.rule, 'model_supplied_approval_token');
  });
});
