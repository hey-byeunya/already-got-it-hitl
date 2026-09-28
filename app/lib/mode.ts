import 'server-only';
import { loadEnvLocal, readEnvLocal } from 'already-got-it-ops-agent/env';
import { PROJECT_ROOT } from './paths';

/**
 * 실행 모드 판정. 실행기(runner.ts) · 화면 배지 · 발행 게이트가 같은 답을 봐야 하므로 여기 한 곳에만 둔다.
 */

let loaded = false;
function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  loadEnvLocal(PROJECT_ROOT);
}

/**
 * 지금 어느 모드로 도는가.
 *
 * **파일을 매번 다시 읽는다.** process.env 를 보면 서버가 뜰 때의 값이 남아 있어,
 * `.env.local` 을 바꿔도 화면이 옛 모드를 말한다 — 실제로 겪었다 (DECISIONS.md D29).
 */
export function opsMode(): 'fixture' | 'live' {
  loadOnce();
  const raw = (readEnvLocal(PROJECT_ROOT, 'OPS_MODE') ?? process.env.OPS_MODE ?? '').trim();
  return raw === 'live' ? 'live' : 'fixture';
}

/** 실제 쓰기가 켜져 있는가. 승인 창이 「진짜 이슈가 만들어진다」를 말할지 정한다. */
export function liveWritesEnabled(): boolean {
  loadOnce();
  const raw = (readEnvLocal(PROJECT_ROOT, 'OPS_ALLOW_LIVE_WRITES')
    ?? process.env.OPS_ALLOW_LIVE_WRITES ?? '').trim();
  return raw === '1';
}
