/**
 * 검사: 결측과 0 을 구별하는가 (DECISIONS.md D15 · EVAL.md 결측 오독률)
 *
 * 발단: 회고에 남은 일 — "각주 검사가 통째로 안 돌았는데 도구가 아무 말도 안 하고,
 * 검출률만 조용히 내려가 있었다." 결측을 0 으로 읽으면 지표가 조용히 거짓말을 한다.
 *
 * f4-sparse 픽스처가 이 상황을 담고 있다.
 *   - deployments: []            → 실제 0 (사실)
 *   - function_errors.count: null → 결측 (모름), unavailable_fields 에 이름이 있다
 * 도구는 이 둘을 서로 다르게 넘겨야 한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES_DIR } from './helpers.js';

test('결측과 0 구별', async (t) => {
  process.env.OPS_FIXTURES_DIR = FIXTURES_DIR;
  const q = `?t=${Math.random()}`;
  const fixtures = await import('../src/fixtures.js' + q) as typeof import('../src/fixtures.js');

  // f5·f6 은 발행 게이트(D43) 검증용으로 더했다 — 기준을 아는 사람이 만든 경계 사례다.
  await t.test('픽스처 6개가 모두 읽힌다', () => {
    const ids = fixtures.listFixtureIds().sort();
    assert.deepEqual(ids, ['f1-normal', 'f2-deploy-fail', 'f3-metric-drop', 'f4-sparse', 'f5-metrics-down', 'f6-error-creep']);
  });

  await t.test('f5-metrics-down — 사용자 지표는 실패를 담고 있다 (실패 경로 재현)', () => {
    const m = fixtures.fixtureResponse('f5-metrics-down', 'get_user_metrics') as any;
    assert.equal(m.error, 'rpc_failed');
    assert.equal(m.totals, undefined, '실패한 응답에 값을 지어내 넣지 않는다');
  });

  await t.test('f4-sparse — 배포는 실제 0, 함수 오류는 결측', () => {
    const sys = fixtures.fixtureResponse('f4-sparse', 'get_system_health') as any;
    assert.deepEqual(sys.deployments, [], '배포 0건은 사실이다');
    assert.equal(sys.summary.total, 0);
    assert.equal(sys.function_errors.count, null, '함수 오류는 모르는 값이다');
    assert.equal(sys.function_errors.available, false);
    assert.ok(
      sys.unavailable_fields.includes('function_errors.count'),
      '조회하지 못한 항목은 unavailable_fields 에 이름이 있어야 한다',
    );
  });

  await t.test('f4-sparse — 전주 비교값이 없으면 null 이고 그 사실이 표시된다', () => {
    const m = fixtures.fixtureResponse('f4-sparse', 'get_user_metrics') as any;
    assert.equal(m.previous_period_totals, null, '비교값 없음은 0 이 아니다');
    assert.ok(m.unavailable_fields.includes('previous_period_totals'));
    assert.ok(m.series.length < 7, '기간 일부가 결측이어야 한다');
  });

  await t.test('f4-sparse — 개발 활동은 실패를 담고 있다 (실패 경로 재현)', () => {
    const dev = fixtures.fixtureResponse('f4-sparse', 'get_dev_activity') as any;
    assert.equal(dev.error, 'rate_limited');
    assert.ok(typeof dev.retry_after_seconds === 'number');
  });

  // ── 경계: 결측이 아닌 것을 결측으로 취급하지 않는다 ──────────
  await t.test('경계 — f1-normal 은 결측이 없다', () => {
    const sys = fixtures.fixtureResponse('f1-normal', 'get_system_health') as any;
    assert.deepEqual(sys.unavailable_fields, []);
    assert.equal(sys.function_errors.available, true);
    assert.equal(typeof sys.function_errors.count, 'number');
  });

  await t.test('경계 — f3-metric-drop 은 지표가 낮지만 결측은 아니다', () => {
    const m = fixtures.fixtureResponse('f3-metric-drop', 'get_user_metrics') as any;
    assert.equal(m.totals.signups, 4, '4 는 실제 값이다');
    assert.ok(m.previous_period_totals, '전주 비교값이 있어야 하락을 말할 수 있다');
    assert.equal(m.previous_period_totals.signups, 19);
  });

  await t.test('f3-metric-drop 의 정답은 "원인을 단정하지 않기"를 요구한다', () => {
    const fx = fixtures.loadFixture('f3-metric-drop') as any;
    const claims: string[] = fx.expected.must_not_claim;
    assert.ok(claims.some((c) => c.includes('원인')), '원인 단정 금지가 정답에 있어야 한다');
    assert.ok(fx.expected.must_flag_unknown, '무엇을 모른다고 밝혀야 하는지가 정의돼 있어야 한다');
  });
});
