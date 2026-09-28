/**
 * 도구 표면. 무엇을 허용하고 무엇을 차단하는지 여기 한 곳에서 정한다.
 *
 * MCP 도구 이름은 `mcp__<서버키>__<도구>` 형태다. 서버키는 mcpServers 의 키(`ops`)다.
 */
export const MCP_SERVER_KEY = 'ops';

const mcp = (name: string) => `mcp__${MCP_SERVER_KEY}__${name}`;

/** 읽기 도구 — 자동 승인한다. 매번 물으면 브리핑을 만들 수 없다. */
export const READ_TOOLS = [
  'get_system_health',
  'get_user_metrics',
  'get_dev_activity',
  'web_search',
  'render_chart',
  // 카드 만들기와 내보내기는 이 실행의 폴더 안에만 쓴다. 외부를 바꾸지 않으므로
  // 사람의 승인을 매번 받지 않는다 — 승인은 저장소를 바꾸는 두 도구에만 둔다.
  'compose_card',
  'export_cardnews',
].map(mcp);

/**
 * 쓰기 도구 — **allowedTools 에 넣지 않는다.**
 *
 * Agent SDK 문서: "Auto-approved tools never reach canUseTool." 여기에 넣으면
 * 승인 콜백을 건너뛰고 자동 실행된다. 게이트가 있는 줄 알았는데 없는 상태가 된다.
 * (DECISIONS.md D14)
 */
export const WRITE_TOOLS = ['create_github_issue', 'revert_issue'].map(mcp);

/**
 * 내장 도구 차단. 맨이름으로 적으면 **도구 정의가 요청에서 빠져** 모델이 존재조차 모른다.
 * 이 앱의 도구는 도메인 API 6개·차트·카드 제작뿐이라 파일·셸 표면이 필요 없다.
 */
export const BLOCKED_BUILTINS = [
  'Bash', 'BashOutput', 'KillShell',
  'Read', 'Write', 'Edit', 'NotebookEdit',
  'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TodoWrite',
  // 첫 실제 실행에서 모델이 실제로 불러 본 것들. 목록에 없으면 표면에 남는다.
  'ToolSearch', 'Skill', 'SlashCommand', 'ListMcpResources', 'ReadMcpResource',
];

/** 이 이름이면 사람의 승인을 지나야 한다. */
export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.includes(toolName);
}

/** 도구 이름에서 MCP 접두어를 뗀 짧은 이름. 승인 기록과 화면 표시에 쓴다. */
export function shortName(toolName: string): string {
  return toolName.replace(`mcp__${MCP_SERVER_KEY}__`, '');
}
