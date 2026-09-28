#!/usr/bin/env node
/**
 * 개발·검증용 승인 토큰 발급기.
 *
 * 실제로는 **앱이** 사람의 승인을 받은 뒤 발급한다. 이 스크립트는 앱이 아직 없는 동안
 * 그 자리를 대신할 뿐이고, MCP 서버는 이 스크립트의 존재를 모른다.
 * (서버가 스스로 토큰을 만들 수 있으면 게이트가 의미를 잃는다.)
 *
 *   node scripts/mint-approval.mjs <run_id> <tool> <target>
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const [runId, tool, target] = process.argv.slice(2);
if (!runId || !tool || !target) {
  console.error('사용법: node scripts/mint-approval.mjs <run_id> <tool> <target>');
  process.exit(2);
}

const runsDir = resolve(process.env.OPS_RUNS_DIR ?? 'runs');
const dir = join(runsDir, runId);
const path = join(dir, 'approvals.json');
mkdirSync(dir, { recursive: true });

const store = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { tokens: [], log: [] };
const ttl = Number(process.env.OPS_APPROVAL_TTL ?? 600);
const token = {
  token: `apr_${randomBytes(18).toString('base64url')}`,
  tool, target,
  expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  used_at: null,
};
store.tokens.push(token);
writeFileSync(path, JSON.stringify(store, null, 2));
console.log(token.token);
