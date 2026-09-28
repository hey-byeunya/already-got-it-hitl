/**
 * 검사: 서버가 실제로 노출하는 도구 표면 (stdio 로 붙어서 확인)
 *
 * 이 검사는 승인 게이트의 첫 번째 겹을 증명한다 (DECISIONS.md D14 ①) —
 * 쓰기 도구에 _meta["anthropic/requiresUserInteraction"] 가 붙어 있으면
 * 클라이언트의 allow 규칙이 매치돼도 항상 승인 콜백으로 떨어진다.
 *
 * 모듈을 직접 부르지 않고 프로토콜로 확인하는 이유: 앱과 Claude Code 가 보는 것이 이 표면이다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { FIXTURES_DIR } from './helpers.js';

const WRITE_TOOLS = ['create_github_issue', 'revert_issue'];
const READ_TOOLS = ['get_system_health', 'get_user_metrics', 'get_dev_activity', 'web_search',
  'render_chart', 'compose_card', 'export_cardnews'];

type Tool = { name: string; description?: string; _meta?: Record<string, unknown>;
              annotations?: Record<string, unknown>; inputSchema?: unknown };

/** 서버를 stdio 로 띄워 initialize → tools/list 를 주고받는다. */
async function listTools(): Promise<Tool[]> {
  const entry = resolve(import.meta.dirname, '../src/index.js');
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, OPS_MODE: 'fixture', OPS_FIXTURES_DIR: FIXTURES_DIR, OPS_FIXTURE_ID: 'f1-normal' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n');
  const responses = new Map<number, any>();
  let buf = '';

  const done = new Promise<void>((resolveP, rejectP) => {
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number') responses.set(msg.id, msg);
        if (msg.id === 2) resolveP();
      }
    });
    child.on('error', rejectP);
    setTimeout(() => rejectP(new Error('서버 응답 시간 초과')), 15000);
  });

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'ops-check', version: '0' },
  } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  try {
    await done;
    const res = responses.get(2);
    assert.ok(res?.result?.tools, 'tools/list 응답에 tools 가 있어야 한다');
    return res.result.tools as Tool[];
  } finally {
    child.kill();
  }
}

test('도구 표면', async (t) => {
  const tools = await listTools();
  const byName = new Map(tools.map((x) => [x.name, x]));

  await t.test('도구 9개가 모두 노출된다', () => {
    assert.deepEqual(
      tools.map((x) => x.name).sort(),
      [...READ_TOOLS, ...WRITE_TOOLS].sort(),
    );
  });

  await t.test('쓰기 도구에는 requiresUserInteraction 이 붙어 있다 (게이트 ①)', () => {
    for (const name of WRITE_TOOLS) {
      const t2 = byName.get(name)!;
      assert.equal(
        t2._meta?.['anthropic/requiresUserInteraction'], true,
        `${name} 에 _meta 가 없으면 allow 규칙만으로 승인이 건너뛰어진다`,
      );
    }
  });

  await t.test('경계 — 읽기 도구에는 붙지 않는다 (매번 물으면 게이트가 무의미해진다)', () => {
    for (const name of READ_TOOLS) {
      const t2 = byName.get(name)!;
      assert.notEqual(t2._meta?.['anthropic/requiresUserInteraction'], true, `${name} 은 자동 승인돼야 한다`);
    }
  });

  await t.test('annotations 로 읽기/파괴 여부를 알린다', () => {
    assert.equal(byName.get('get_system_health')!.annotations?.readOnlyHint, true);
    assert.equal(byName.get('create_github_issue')!.annotations?.readOnlyHint, false);
    assert.equal(byName.get('revert_issue')!.annotations?.destructiveHint, true);
  });

  await t.test('description 이 제약을 문장으로 담고 있다', () => {
    assert.match(byName.get('get_system_health')!.description!, /추측하지 말고/);
    assert.match(byName.get('render_chart')!.description!, /source/);
    assert.match(byName.get('create_github_issue')!.description!, /승인/);
    assert.match(byName.get('revert_issue')!.description!, /임의의 이슈를 닫을 수 없다/);
    // 카드 도구도 제약을 설명에 담아야 한다 — 설명과 검사가 어긋나면 설명은 아무것도 제한하지 않는다.
    assert.match(byName.get('compose_card')!.description!, /잘라서 그리지 않고/);
    assert.match(byName.get('export_cardnews')!.description!, /opened_ok/);
  });
});
