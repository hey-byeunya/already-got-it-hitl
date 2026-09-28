/**
 * 도구 등록 공통부. 모든 도구가 같은 규약을 지나게 한다.
 *
 *  - 실행을 열고 (첫 호출이 픽스처를 확정한다)
 *  - 소요 시간을 재고
 *  - 입력·출력 전문을 실행 기록에 남기고
 *  - ToolError 는 예외가 아니라 **도구 결과**로 되돌린다 (isError: true)
 *
 * 쓰기 도구에는 _meta["anthropic/requiresUserInteraction"] 를 붙인다.
 * 이게 붙으면 클라이언트의 allow 규칙이 매치돼도 항상 승인 콜백으로 떨어진다.
 * 승인 게이트의 첫 번째 겹이다 (DECISIONS.md D14 ①).
 */
import type { CallToolResult, McpServer, StandardSchemaWithJSON, ToolCallback } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ToolError } from './errors.js';
import { openRun, record } from './runlog.js';

/** 모든 도구가 공통으로 받는 입력. run_id 로 기록과 근거를 묶는다. */
export const baseInput = {
  run_id: z.string().describe('이 브리핑 실행의 ID. 도구 호출 기록과 근거가 이 ID로 묶인다'),
  fixture_id: z.string().optional()
    .describe('fixture 모드에서 읽을 스냅샷. 실행의 첫 호출에서만 유효하고 이후에는 고정된다'),
};

export type BaseArgs = { run_id: string; fixture_id?: string | undefined };

export function defineTool<A extends BaseArgs>(
  server: McpServer,
  opts: {
    name: string;
    description: string;
    inputSchema: z.ZodType<A, unknown>;
    /** 쓰기 도구인가. true 면 항상 사람의 승인 콜백을 지난다. */
    requiresApproval?: boolean;
    /** 되돌릴 수 없는 작업인가. annotations 로 클라이언트에 알린다. */
    destructive?: boolean;
    handler: (args: A) => Promise<unknown> | unknown;
  },
): void {
  const { name, description, inputSchema, requiresApproval = false, destructive = false, handler } = opts;

  const run = async (raw: unknown): Promise<CallToolResult> => {
    const args = raw as A;
    const started = Date.now();
    const runId = args.run_id;
    try {
      openRun(runId, args.fixture_id ?? null);
      const output = await handler(args);
      record(runId, { tool: name, input: args, output, ok: true, elapsed_ms: Date.now() - started });
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    } catch (err) {
      const payload = err instanceof ToolError
        ? err.asResult()
        : { error: 'unexpected_error', message: err instanceof Error ? err.message : String(err) };
      // 실패도 기록한다. 조용히 사라지지 않게.
      try {
        record(runId, { tool: name, input: args, output: payload, ok: false, elapsed_ms: Date.now() - started });
      } catch { /* run_id 자체가 잘못된 경우 기록할 곳이 없다 */ }
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
    }
  };

  server.registerTool(
    name,
    {
      description,
      // zod 스키마는 Standard Schema 를 만족하지만 SDK 의 제네릭 추론과 형태가 달라
      // 이 경계에서만 캐스팅한다. 런타임 검증은 SDK 가 이 스키마로 그대로 수행한다.
      inputSchema: inputSchema as unknown as StandardSchemaWithJSON,
      annotations: {
        title: name,
        readOnlyHint: !requiresApproval,
        destructiveHint: destructive,
        idempotentHint: !requiresApproval,
        openWorldHint: true,
      },
      // 승인 게이트 ① — 이 도구는 allow 규칙이 있어도 항상 사람의 확인을 지난다.
      ...(requiresApproval ? { _meta: { 'anthropic/requiresUserInteraction': true } } : {}),
    },
    run as unknown as ToolCallback<StandardSchemaWithJSON>,
  );
}
