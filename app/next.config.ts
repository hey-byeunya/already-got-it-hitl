import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // 상위 폴더(ai-agent/project)에 무관한 package-lock.json 이 있어서
  // Turbopack 이 워크스페이스 루트를 거기로 잘못 잡는다.
  // 루트는 이 저장소 폴더 — app · agent · mcp-server 를 모두 품는 자리여야 한다
  // (agent 와 mcp-server 는 file: 의존성이라 루트 밖이면 해결되지 않는다).
  turbopack: {
    root: path.join(__dirname, '..'),
  },

  // 엔진과 MCP 클라이언트는 Node 런타임에서만 돈다. 번들에 끌어넣지 않는다.
  serverExternalPackages: [
    'already-got-it-ops-agent',
    'already-got-it-ops-mcp',
    '@anthropic-ai/claude-agent-sdk',
  ],
};

export default config;
