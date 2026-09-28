/**
 * 픽스처 로더. fixture 모드에서 네 축의 응답을 여기서 읽는다.
 *
 * 픽스처는 도구 응답을 그대로 담고 있다 (TOOLS.md 의 출력 형태와 같다).
 * get_dev_activity 처럼 실패를 담은 픽스처도 있다 — f4-sparse 는 rate_limited 를 돌려준다.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { FatalToolError } from './errors.js';

export type Fixture = {
  id: string;
  label: string;
  as_of: string;
  period: { since: string; until: string; tz: string };
  get_system_health?: unknown;
  get_user_metrics?: unknown;
  get_dev_activity?: unknown;
  web_search?: unknown;
  expected?: unknown;
};

// 캐시 키에 디렉터리를 포함한다. 검사가 픽스처 경로를 바꿔 끼울 때
// 앞선 경로의 내용이 남아 있으면 안 된다.
const cache = new Map<string, Fixture>();
const cacheKey = (id: string) => `${config.fixturesDir}::${id}`;

export function loadFixture(id: string): Fixture {
  const cached = cache.get(cacheKey(id));
  if (cached) return cached;

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new FatalToolError('invalid_fixture_id', 'fixture_id 형식이 잘못됐다', { fixture_id: id });
  }
  const path = join(config.fixturesDir, `${id}.json`);
  if (!existsSync(path)) {
    throw new FatalToolError('fixture_not_found', `픽스처를 찾을 수 없다: ${id}`, {
      looked_in: config.fixturesDir,
      available: listFixtureIds(),
    });
  }
  const fx = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
  cache.set(cacheKey(id), fx);
  return fx;
}

export function listFixtureIds(): string[] {
  if (!existsSync(config.fixturesDir)) return [];
  return readdirSync(config.fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

/**
 * 픽스처에서 도구 응답을 꺼낸다.
 * 응답 자체가 error 를 담고 있으면 그대로 오류로 올린다 — 실패 경로도 픽스처로 재현한다.
 */
export function fixtureResponse(fixtureId: string, tool: keyof Fixture): unknown {
  const fx = loadFixture(fixtureId);
  const val = fx[tool];
  if (val === undefined) {
    throw new FatalToolError('fixture_missing_tool', `픽스처 ${fixtureId} 에 ${String(tool)} 응답이 없다`, {
      fixture_id: fixtureId, tool: String(tool),
    });
  }
  return val;
}
