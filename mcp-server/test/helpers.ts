import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 검사마다 일회용 runs 폴더를 쓴다. 검사끼리 상태를 물려주지 않게.
 *
 * **동기 콜백만 받는다.** async 콜백을 넘기면 본문이 끝나기 전에 finally 가
 * 폴더를 지워, 파일이 없다고 나온다. 비동기가 필요하면 withTempRunsAsync 를 쓴다.
 */
export function withTempRuns<T>(fn: (runsDir: string) => T extends Promise<unknown> ? never : T): T {
  const dir = mkdtempSync(join(tmpdir(), 'ops-mcp-'));
  const prev = process.env.OPS_RUNS_DIR;
  process.env.OPS_RUNS_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.OPS_RUNS_DIR;
    else process.env.OPS_RUNS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 컴파일된 위치(dist/test)에서 저장소 루트의 fixtures 로 올라간다.
 * dist/test → dist → mcp-server → 저장소 루트
 */
export const FIXTURES_DIR = resolve(import.meta.dirname, '../../../fixtures/snapshots');

/** 위와 같지만 async 콜백을 기다린다. */
export async function withTempRunsAsync<T>(fn: (runsDir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'ops-mcp-'));
  const prev = process.env.OPS_RUNS_DIR;
  process.env.OPS_RUNS_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.OPS_RUNS_DIR;
    else process.env.OPS_RUNS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}
