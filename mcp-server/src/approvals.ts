/**
 * 승인 게이트의 두 번째 겹 (DECISIONS.md D14 ②).
 *
 * 쓰기 도구는 유효한 1회용 approval_token 없이 실행되지 않는다. 검사를 **이 서버가** 하므로,
 * 앱을 우회해 서버에 직접 붙어도 막힌다. 게이트가 앱 안의 약속이 아니라 경계에서 강제되는 규칙이 된다.
 *
 * 토큰 발급은 이 서버의 일이 아니다. 사람의 승인을 받은 앱만 발급한다.
 * (개발·검증용 발급기는 scripts/mint-approval.mjs 에 따로 두었다.)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ToolError } from './errors.js';
import { runPath } from './runlog.js';

export type ApprovalToken = {
  token: string;
  tool: string;
  /** 대상 리소스. 저장소·이슈 번호처럼 무엇에 대한 승인인지 못 박는다. */
  target: string;
  expires_at: string;
  used_at: string | null;
};

export type ApprovalLogEntry = {
  at: string;
  tool: string;
  target: string;
  /** 실행 결과로 만들어진 것. revert_issue 의 대상 범위가 된다. */
  created?: { issue_number: number; repo: string };
  reverted?: { issue_number: number };
};

type Store = { tokens: ApprovalToken[]; log: ApprovalLogEntry[] };

function storePath(runId: string): string {
  return runPath(runId, 'approvals.json');
}

function load(runId: string): Store {
  const p = storePath(runId);
  if (!existsSync(p)) return { tokens: [], log: [] };
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Store;
  } catch {
    // 깨진 승인 기록으로 승인 판정을 내리지 않는다. 고쳐 쓰지도 않는다 —
    // 토큰·로그를 지어내 복원하면 revert 범위가 어긋난다. 새 run_id 로 시작한다.
    throw new ToolError('approvals_corrupted',
      '승인 기록 파일이 깨졌다. 수선하지 않고 그대로 두며, 새 run_id 로 시작한다',
      { path: p });
  }
}

function save(runId: string, s: Store): void {
  const p = storePath(runId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s, null, 2));
}

/**
 * 토큰을 검사하고 소비한다. 실패 사유를 TOOLS.md 의 코드로 구분해 돌려준다.
 * 성공하면 토큰은 소멸한다 — 같은 승인으로 두 번 실행할 수 없다.
 */
export function consume(runId: string, token: string | undefined, tool: string, target: string): ApprovalToken {
  const store = load(runId);

  if (!token) {
    throw new ToolError('approval_required', `${tool} 은 사람의 승인이 필요하다. approval_token 없이는 실행되지 않는다`, {
      tool, target, how_to_fix: '앱의 승인 화면에서 승인을 받아 토큰을 발급받는다',
    });
  }

  const found = store.tokens.find((t) => t.token === token);
  if (!found) {
    throw new ToolError('approval_required', '승인 토큰을 찾을 수 없다', { tool, target });
  }
  if (found.used_at) {
    throw new ToolError('token_already_used', '이미 사용된 승인 토큰이다. 같은 승인으로 두 번 실행하지 않는다', {
      tool, target, used_at: found.used_at,
    });
  }
  if (new Date(found.expires_at).getTime() < Date.now()) {
    throw new ToolError('approval_expired', '승인 토큰이 만료됐다. 다시 승인을 받는다', {
      tool, target, expires_at: found.expires_at,
    });
  }
  if (found.tool !== tool) {
    throw new ToolError('approval_scope_mismatch', '이 토큰은 다른 도구에 대한 승인이다', {
      requested_tool: tool, token_tool: found.tool,
    });
  }
  if (found.target !== target) {
    throw new ToolError('approval_scope_mismatch', '이 토큰은 다른 대상에 대한 승인이다', {
      requested_target: target, token_target: found.target,
    });
  }

  found.used_at = new Date().toISOString();
  save(runId, store);
  return found;
}

export function appendLog(runId: string, entry: ApprovalLogEntry): void {
  const store = load(runId);
  store.log.push(entry);
  save(runId, store);
}

/** 이 실행이 승인 기록으로 만든 이슈 번호들. revert_issue 의 허용 범위. */
export function createdIssueNumbers(runId: string): number[] {
  return load(runId).log.flatMap((e) => (e.created ? [e.created.issue_number] : []));
}

/**
 * 그 이슈를 만든 저장소. revert_issue 가 닫을 대상을 **기록에서** 가져오게 한다.
 * 저장소를 입력으로 받으면, 승인 기록에 있는 번호로 다른 저장소의 이슈를 닫을 수 있다.
 */
export function createdIssueRepo(runId: string, issueNumber: number): string | undefined {
  return load(runId).log.find((e) => e.created?.issue_number === issueNumber)?.created?.repo;
}

export function isAlreadyReverted(runId: string, issueNumber: number): boolean {
  return load(runId).log.some((e) => e.reverted?.issue_number === issueNumber);
}

/** 앱이 승인을 받은 뒤 호출한다. 이 서버의 도구로는 노출하지 않는다. */
export function issueToken(runId: string, tool: string, target: string, ttlSeconds: number): ApprovalToken {
  const store = load(runId);
  const t: ApprovalToken = {
    // 1회용이고 시한이 있어도 맞힐 수 있으면 게이트 ②가 뚫린다 — 예측할 수 없는 난수를 쓴다.
    token: `apr_${randomBytes(18).toString('base64url')}`,
    tool,
    target,
    expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    used_at: null,
  };
  store.tokens.push(t);
  save(runId, store);
  return t;
}
