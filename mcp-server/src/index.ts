#!/usr/bin/env node
/**
 * 「이미 있어」 운영 브리핑 에이전트의 도메인 도구 MCP 서버 (stdio).
 *
 * 도구는 여기 한 곳에만 구현한다. 두 클라이언트가 같은 서버를 붙여 쓴다.
 *   - 앱 (Next.js)  : Claude Agent SDK 의 mcpServers 옵션
 *   - Claude Code   : .mcp.json
 *
 * 그래서 승인 게이트를 앱 화면이 아니라 **서버 경계**에 둘 수 있다 (DECISIONS.md D13·D14).
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { config } from './config.js';
import { registerAllTools } from './tools.js';
import { listFixtureIds } from './fixtures.js';

const server = new McpServer({ name: 'already-got-it-ops', version: '0.1.0' });
registerAllTools(server);

async function main(): Promise<void> {
  // stdout 은 MCP 프로토콜 전용이다. 사람에게 하는 말은 전부 stderr 로 보낸다.
  console.error(`[ops-mcp] mode=${config.mode} runs=${config.runsDir}`);
  if (config.mode === 'fixture') {
    console.error(`[ops-mcp] fixtures=${config.fixturesDir} available=${listFixtureIds().join(', ') || '(없음)'}`);
    console.error('[ops-mcp] fixture 모드다. 외부 API 를 부르지 않고 쓰기 도구도 실제 저장소를 바꾸지 않는다.');
  }
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('[ops-mcp] 시작 실패:', err);
  process.exit(1);
});
