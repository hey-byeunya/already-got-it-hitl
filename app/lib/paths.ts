import { resolve } from 'node:path';

/** 저장소 루트 (app/ 의 부모). 실행 기록·픽스처·.env.local 이 여기 기준이다. */
export const PROJECT_ROOT = resolve(process.cwd(), '..');
export const RUNS_DIR = resolve(PROJECT_ROOT, 'runs');
export const FIXTURES_DIR = resolve(PROJECT_ROOT, 'fixtures/snapshots');
export const MCP_ENTRY = resolve(PROJECT_ROOT, 'mcp-server/dist/src/index.js');
