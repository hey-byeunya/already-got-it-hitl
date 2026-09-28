/**
 * 검사: 프롬프트의 의존성 목록이 live 검색 범위와 어긋나지 않는다 (P2-2).
 *
 * 이름의 정본은 MCP 서버의 WATCHED_PACKAGES 다. 버전 힌트 문안은 prompt.ts 가 얹는다.
 * 정본에 이름이 늘었는데 문안에 빠지면 import 시점에 터진다 — 조용히 어긋나지 않게.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WATCHED_PACKAGES } from 'already-got-it-ops-mcp/config';
import { APP_DEPENDENCIES, systemPrompt } from '../src/prompt.js';

test('의존성 목록 정합', async (t) => {
  await t.test('정본의 모든 이름이 프롬프트 문안에 들어 있다', () => {
    const text = APP_DEPENDENCIES.join('\n');
    for (const p of WATCHED_PACKAGES) {
      const short = p.replace(/^@[^/]+\//, '');
      assert.ok(text.includes(p) || text.includes(short), `${p} 가 프롬프트에 없다`);
    }
  });

  // 도구가 category 를 필수로 받는데 프롬프트가 말하지 않으면 모든 카드가 한 번씩 거절된다.
  await t.test('시스템 프롬프트가 compose_card 의 category 세 값을 알려 준다 (D40)', () => {
    const s = systemPrompt({ runId: 'r1', repo: 'owner/repo' });
    for (const v of ['fix_now', 'watch', 'fyi']) assert.ok(s.includes(`\`${v}\``), `${v} 가 프롬프트에 없다`);
  });

  // 화면의 버튼·딱지는 영어로 맞췄다. 질문의 선택지 이름은 모델이 쓰므로 프롬프트가 정한다.
  await t.test('질문의 header 와 선택지 label 을 짧은 영어로 쓰라고 한다', () => {
    const s = systemPrompt({ runId: 'r1', repo: 'owner/repo' });
    assert.ok(s.includes('proceed (recommended)'), '영어 선택지 예시가 프롬프트에 없다');
  });

  await t.test('시스템 프롬프트에 의존성 목록이 들어간다', () => {
    const s = systemPrompt({ runId: 'r1', repo: 'owner/repo' });
    assert.ok(s.includes('next 16.2.x'), '의존성 문안이 프롬프트에서 빠졌다');
  });
});
