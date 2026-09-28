/**
 * 검사: 승인 게이트가 가려졌는지 감시한다 (DECISIONS.md D14 자체 검사)
 *
 * 막아야 할 것: **쓰기 도구**가 allowedTools 로 자동 승인돼 canUseTool 을 건너뛰는 것.
 *   그러면 승인 화면 없이 GitHub 에 기록이 남는다.
 *
 * 막으면 안 되는 것(경계): **읽기 도구**의 자동 승인. 이 앱은 읽기 도구를 의도적으로
 *   allowedTools 에 넣는다. 매번 물으면 브리핑을 만들 수 없다.
 *
 * 이 경계 검사는 첫 실제 실행에서 나왔다 — 처음에는 경고만 보고 전부 실패시켜,
 * 정상 설정이 막혔다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowGuard, parseShadowedTools } from '../src/shadowguard.js';
import { READ_TOOLS, WRITE_TOOLS } from '../src/tools.js';

/**
 * 실제 SDK 가 띄운 경고 문장. 첫 실행에서 그대로 받아 왔다.
 *
 * **이 문장은 고치지 않는다.** 그때 읽기 도구가 5개였던 기록이다.
 * 그 뒤 카드 도구 두 개가 늘어 READ_TOOLS 는 7개가 됐지만, 이 검사가 보는 것은
 * "경고 문장에서 이름을 뽑아낼 수 있는가" 이지 "지금 몇 개인가" 가 아니다.
 * READ_TOOLS 와 대조하도록 두었더니 도구를 늘렸을 때 무관한 검사가 깨졌다.
 */
const WARNED_TOOLS = [
  'mcp__ops__get_system_health', 'mcp__ops__get_user_metrics',
  'mcp__ops__get_dev_activity', 'mcp__ops__web_search', 'mcp__ops__render_chart',
];
const REAL_WARNING =
  `canUseTool will not be invoked for: ${WARNED_TOOLS.join(', ')}.`
  + ' Bare allowedTools entries auto-approve the whole tool before the callback is consulted.';

function emitShadowWarning(message: string): void {
  const w = new Error(message) as Error & { code?: string };
  w.name = 'Warning';
  w.code = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED';
  process.emit('warning', w);
}

test('셰도잉 감시', async (t) => {
  await t.test('경고 문장에서 가려진 도구 이름을 뽑는다', () => {
    assert.deepEqual(parseShadowedTools(REAL_WARNING), WARNED_TOOLS);
    assert.deepEqual(parseShadowedTools('관계없는 문장'), []);
  });

  await t.test('경계 — 읽기 도구만 가려진 것은 정상이다 (실제 실행에서 나온 경우)', async () => {
    const g = new ShadowGuard(WRITE_TOOLS);
    g.arm();
    try {
      emitShadowWarning(REAL_WARNING);
      await new Promise((r) => setImmediate(r));

      assert.deepEqual(g.shadowed, WARNED_TOOLS, '경고 내용은 기록한다');
      assert.deepEqual(g.gatedButShadowed, [], '쓰기 도구는 가려지지 않았다');
      g.assertGateIntact(); // 던지지 않아야 한다
    } finally { g.disarm(); }
  });

  await t.test('쓰기 도구가 가려지면 실패로 처리한다', async () => {
    const g = new ShadowGuard(WRITE_TOOLS);
    g.arm();
    try {
      emitShadowWarning(
        `canUseTool will not be invoked for: ${READ_TOOLS[0]}, ${WRITE_TOOLS[0]}.`,
      );
      await new Promise((r) => setImmediate(r));

      assert.deepEqual(g.gatedButShadowed, [WRITE_TOOLS[0]]);
      assert.throws(() => g.assertGateIntact(), /승인 게이트가 가려졌다/);
    } finally { g.disarm(); }
  });

  await t.test('쓰기 도구 둘 다 가려지면 둘 다 보고한다', async () => {
    const g = new ShadowGuard(WRITE_TOOLS);
    g.arm();
    try {
      emitShadowWarning(`canUseTool will not be invoked for: ${WRITE_TOOLS.join(', ')}.`);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(g.gatedButShadowed.sort(), [...WRITE_TOOLS].sort());
    } finally { g.disarm(); }
  });

  await t.test('경계 — 관계없는 경고는 무시한다', async () => {
    const g = new ShadowGuard(WRITE_TOOLS);
    g.arm();
    try {
      const w = new Error('DeprecationWarning: something else') as Error & { code?: string };
      w.name = 'Warning'; w.code = 'DEP0040';
      process.emit('warning', w);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(g.shadowed, []);
      g.assertGateIntact();
    } finally { g.disarm(); }
  });

  await t.test('disarm 뒤에는 더 듣지 않는다', async () => {
    const g = new ShadowGuard(WRITE_TOOLS);
    g.arm(); g.disarm();
    emitShadowWarning(`canUseTool will not be invoked for: ${WRITE_TOOLS[0]}.`);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(g.shadowed, []);
  });
});
