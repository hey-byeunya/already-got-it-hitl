/**
 * 검사: .env.local 파서 (P2-5).
 *
 * 세 실행기가 같은 로더를 쓴다. `=` 포함 값·주석·따옴표 경계를 여기서 고정한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvLine } from '../src/env.js';

test('.env.local 파서', async (t) => {
  await t.test('기본 형태를 읽는다', () => {
    assert.deepEqual(parseEnvLine('OPS_MODE=live'), ['OPS_MODE', 'live']);
    assert.deepEqual(parseEnvLine('  OPS_MODE = live  '), ['OPS_MODE', 'live']);
  });

  await t.test('값 안의 `=`는 깨지지 않는다', () => {
    assert.deepEqual(parseEnvLine('KEY=a=b=c'), ['KEY', 'a=b=c']);
  });

  await t.test('빈 줄·주석·키 없는 줄은 건너뛴다', () => {
    assert.equal(parseEnvLine(''), null);
    assert.equal(parseEnvLine('   '), null);
    assert.equal(parseEnvLine('# 주석'), null);
    assert.equal(parseEnvLine('  # 앞공백 주석'), null);
    assert.equal(parseEnvLine('=값만'), null);
    assert.equal(parseEnvLine('소문자키=값'), null);
  });

  await t.test('감싸는 따옴표 한 겹만 벗긴다 — 짝이 안 맞으면 그대로 둔다', () => {
    assert.deepEqual(parseEnvLine('A="hello"'), ['A', 'hello']);
    assert.deepEqual(parseEnvLine("A='hello'"), ['A', 'hello']);
    assert.deepEqual(parseEnvLine('A="a\'b'), ['A', '"a\'b']);
    assert.deepEqual(parseEnvLine('A='), ['A', '']);
  });
});
