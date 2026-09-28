/**
 * 검사: 지어낸 수치로 차트를 그릴 수 없는가 (TOOLS.md render_chart)
 *
 * 발단: 카드에 실린 숫자는 사실처럼 읽힌다. 모델이 기억이나 추측으로 만든 값이 차트가 되면
 * 운영 판단의 근거가 오염된다. EVAL.md 의 환각률이 이걸 재고, 이 검사가 코드로 막는다.
 *
 * 경계: 실제 도구 결과에 있는 값은 반드시 통과해야 한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTempRuns } from './helpers.js';
import * as chart from '../src/chart.js';
import * as runlog from '../src/runlog.js';

test('render_chart 근거 대조', async (t) => {

  const METRICS = {
    series: [
      { date: '09-02', signups: 3, active_users: 17 },
      { date: '09-03', signups: 5, active_users: 19 },
    ],
    totals: { signups: 8, active_users: 36 },
  };

  /** 이 실행이 get_user_metrics 를 실제로 호출했다는 기록을 심는다. */
  const seed = () => {
    runlog.openRun('r1', 'f1-normal');
    runlog.record('r1', { tool: 'get_user_metrics', input: {}, output: METRICS, ok: true, elapsed_ms: 1 });
  };

  t.test('근거 도구를 호출한 적 없으면 source_not_found', async () => {
    withTempRuns(() => {
      runlog.openRun('r1', 'f1-normal');
      assert.throws(
        () => chart.verifySource('r1', { tool: 'get_user_metrics', field: 'series[].signups' },
          [{ label: '09-02', value: 3 }]),
        (e: any) => e.code === 'source_not_found',
      );
    });
  });

  t.test('근거에 없는 값이 있으면 source_mismatch — 지어낸 수치를 막는다', async () => {
    withTempRuns(() => {
      seed();
      assert.throws(
        () => chart.verifySource('r1', { tool: 'get_user_metrics', field: 'series[].signups' },
          [{ label: '09-02', value: 3 }, { label: '09-03', value: 99 }]), // 99 는 자료에 없다
        (e: any) => e.code === 'source_mismatch'
          && Array.isArray(e.extra.offending_points)
          && e.extra.offending_points[0].value === 99,
      );
    });
  });

  t.test('빈 데이터는 empty_chart_data', async () => {
    withTempRuns(() => {
      seed();
      assert.throws(
        () => chart.verifySource('r1', { tool: 'get_user_metrics', field: 'series[].signups' }, []),
        (e: any) => e.code === 'empty_chart_data',
      );
    });
  });

  t.test('숫자를 가리키지 않는 경로는 source_field_empty', async () => {
    withTempRuns(() => {
      seed();
      assert.throws(
        () => chart.verifySource('r1', { tool: 'get_user_metrics', field: 'series[].date' },
          [{ label: 'x', value: 3 }]),
        (e: any) => e.code === 'source_field_empty',
      );
    });
  });

  // ── 경계: 막으면 안 되는 것 ──────────────────────────────────
  t.test('경계 — 자료에 있는 값은 통과한다', async () => {
    withTempRuns(() => {
      seed();
      chart.verifySource('r1', { tool: 'get_user_metrics', field: 'series[].signups' },
        [{ label: '09-02', value: 3 }, { label: '09-03', value: 5 }]);
    });
  });

  t.test('경계 — totals 같은 단일 값도 통과한다', async () => {
    withTempRuns(() => {
      seed();
      chart.verifySource('r1', { tool: 'get_user_metrics', field: 'totals.active_users' },
        [{ label: '합계', value: 36 }]);
    });
  });

  t.test('field 해석 — series[].x · totals.x · 배열 인덱스', async () => {
    assert.deepEqual(chart.resolveField(METRICS, 'series[].signups'), [3, 5]);
    assert.deepEqual(chart.resolveField(METRICS, 'totals.signups'), [8]);
    assert.deepEqual(chart.resolveField(METRICS, 'series[1].active_users'), [19]);
    assert.deepEqual(chart.resolveField(METRICS, 'series[].없는필드'), []);
  });

  t.test('SVG 는 파일이 실제로 열려야 완료다 (opened_ok 원칙)', () => {
    withTempRuns((dir) => {
      const svg = chart.renderBarChart({ title: '가입', data: [{ label: 'a', value: 3 }] });
      const res = chart.writeSvg(`${dir}/c.svg`, svg);
      assert.equal(res.rendered_ok, true);
      assert.ok(res.bytes > 0);

      const bad = chart.writeSvg(`${dir}/bad.svg`, '<svg>잘린');
      assert.equal(bad.rendered_ok, false, '닫히지 않은 SVG 는 완료로 표시되지 않아야 한다');
    });
  });
});

/**
 * 검사: 첫 실제 실행에서 나온 마찰 두 개 (관측된 실패 하나당 검사 하나)
 */
import { normalizeToolName } from '../src/chart.js';

test('실제 실행에서 나온 마찰', async (t) => {
  const METRICS2 = {
    series: [{ date: '09-02', active_users: 19 }, { date: '09-03', active_users: 18 }],
    totals: { signups: 17, owned_created: 185, wish_created: 60 },
  };
  const seed2 = () => {
    runlog.openRun('r2', 'f1-normal');
    runlog.record('r2', { tool: 'get_user_metrics', input: {}, output: METRICS2, ok: true, elapsed_ms: 1 });
  };

  t.test('source.tool 은 MCP 접두어가 붙어 와도 받는다', () => {
    assert.equal(normalizeToolName('mcp__ops__get_user_metrics'), 'get_user_metrics');
    assert.equal(normalizeToolName('get_user_metrics'), 'get_user_metrics');
    assert.equal(normalizeToolName('mcp__already-got-it-ops__get_dev_activity'), 'get_dev_activity');
  });

  t.test('접두어가 붙은 이름으로도 근거 대조가 통과한다', () => {
    withTempRuns(() => {
      seed2();
      // 모델이 부르는 이름 그대로 넘겨도 통과해야 한다. 형식 맞추기는 도구의 일이다.
      chart.verifySource('r2', { tool: 'mcp__ops__get_user_metrics', field: 'series[].active_users' },
        [{ label: '9/2', value: 19 }]);
    });
  });

  t.test('숫자들을 담은 객체(totals)도 근거로 쓸 수 있다', () => {
    withTempRuns(() => {
      seed2();
      chart.verifySource('r2', { tool: 'get_user_metrics', field: 'totals' },
        [{ label: '가입', value: 17 }, { label: '등록', value: 185 }, { label: '위시', value: 60 }]);
    });
  });

  t.test('경계 — 객체를 허용해도 없는 값은 여전히 막는다', () => {
    withTempRuns(() => {
      seed2();
      assert.throws(
        () => chart.verifySource('r2', { tool: 'get_user_metrics', field: 'totals' },
          [{ label: '가입', value: 17 }, { label: '지어냄', value: 9999 }]),
        (e: any) => e.code === 'source_mismatch',
      );
    });
  });
});

/**
 * 검사: compose_card sources 행 대조 (TOOLS.md 6절)
 *
 * render_chart 가 값의 부분집합을 본다면, compose 는 행의 존재를 본다.
 * 문자열 근거(빌드 오류 원문·이슈 제목)도 정당하므로 숫자 검사는 하지 않는다.
 */
test('compose_card 근거 행 대조', async (t) => {

  const seed3 = () => {
    runlog.openRun('r3', 'f1-normal');
    runlog.record('r3', { tool: 'get_user_metrics', input: {},
      output: { totals: { signups: 8 } }, ok: true, elapsed_ms: 1 });
    runlog.record('r3', { tool: 'get_system_health', input: {},
      output: { deployments: [{ id: 'dpl_abc', build_error: 'Type error' }] },
      ok: true, elapsed_ms: 1 });
  };

  t.test('"도구 · 필드" 형식이면 통과하고 파싱 결과를 돌려준다', () => {
    withTempRuns(() => {
      seed3();
      assert.deepEqual(chart.verifySourceRow('r3', 'get_user_metrics · totals.signups'),
        { tool: 'get_user_metrics', field: 'totals.signups' });
    });
  });

  t.test('문자열 근거도 통과한다 — 숫자 검사는 하지 않는다', () => {
    withTempRuns(() => {
      seed3();
      chart.verifySourceRow('r3', 'get_system_health · deployments[0].build_error');
    });
  });

  t.test('필드 뒤 괄호 메모는 허용된다 (description 예시와 같은 형태)', () => {
    withTempRuns(() => {
      seed3();
      chart.verifySourceRow('r3', 'get_system_health · deployments[0].id (배포 dpl_abc)');
      chart.verifySourceRow('r3', 'get_user_metrics · totals.signups (가입 8)');
    });
  });

  t.test('형식이 아니면 source_shape_invalid', () => {
    withTempRuns(() => {
      seed3();
      for (const bad of ['그냥 문장', '· totals', 'get_user_metrics ·', '·']) {
        assert.throws(
          () => chart.verifySourceRow('r3', bad),
          (e: any) => e.code === 'source_shape_invalid',
          `거절돼야 한다: ${bad}`,
        );
      }
    });
  });

  t.test('호출한 적 없는 도구면 source_not_found', () => {
    withTempRuns(() => {
      seed3();
      assert.throws(
        () => chart.verifySourceRow('r3', 'web_search · results'),
        (e: any) => e.code === 'source_not_found',
      );
    });
  });

  t.test('값이 없는 필드면 source_field_empty', () => {
    withTempRuns(() => {
      seed3();
      assert.throws(
        () => chart.verifySourceRow('r3', 'get_user_metrics · totals.없는값'),
        (e: any) => e.code === 'source_field_empty',
      );
    });
  });

  t.test('경계 — MCP 접두어가 붙은 도구 이름도 받는다', () => {
    withTempRuns(() => {
      seed3();
      assert.deepEqual(chart.verifySourceRow('r3', 'mcp__ops__get_user_metrics · totals.signups'),
        { tool: 'get_user_metrics', field: 'totals.signups' });
    });
  });
});
