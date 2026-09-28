/**
 * live 모드의 HTTP 호출부. 네 출처가 같은 실패 규약을 지나게 한다.
 *
 * 픽스처 모드에서는 이 파일이 아예 실행되지 않는다. 그래서 평가와 캡처는
 * 네트워크 상태와 무관하게 재현된다 (DECISIONS.md D4).
 *
 * 실패를 코드로 나눈다 — 재시도가 소용있는 것과 없는 것을 구별해야
 * 모델이 헛되게 같은 호출을 반복하지 않는다.
 *   auth_failed        : 자격증명 문제. 재시도 무의미 → Fatal
 *   scope_denied       : 토큰 권한 밖. 재시도 무의미 → Fatal
 *   upstream_not_found : 경로·대상이 없다. 재시도 무의미 → Fatal
 *   rate_limited       : 잠시 뒤 가능. retry_after 를 함께 준다
 *   upstream_error     : 서버 오류. 내부에서 이미 재시도했다
 *   network_error      : 연결 실패·시간 초과
 */
import { FatalToolError, ToolError } from '../errors.js';

/**
 * 타임아웃·재시도 횟수는 호출 시점에 읽는다. 모듈 로드 시점에 고정하면
 * 검사에서 실행마다 다른 값을 줄 수 없고 앞선 검사의 상태가 뒤로 새어 나간다
 * (config.ts 가 같은 이유로 getter 로 읽는다).
 */
function timeoutMs(): number {
  return Number(process.env.OPS_HTTP_TIMEOUT_MS ?? 15_000);
}

function maxRetries(): number {
  return Number(process.env.OPS_HTTP_RETRIES ?? 2);
}

export type RequestSpec = {
  url: string;
  method?: 'GET' | 'POST' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  /** 어느 출처인가. 오류 메시지에 그대로 들어간다. */
  source: string;
  /**
   * 정상 응답의 형태 검사. JSON 이 아니거나 모양이 다르면 true 를 돌려주지 않는다.
   * 없으면 검사를 건너뛴다 — HTML 에러 페이지가 빈 목록으로 둔갑해
   * "배포 0건" 같은 거짓 사실로 보고되는 것을 막는다 (결측-0 구별).
   */
  validate?: (v: unknown) => boolean;
};

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/** 실패 정보에 URL 은 담되 자격증명 헤더는 절대 담지 않는다. */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    // 쿼리에 토큰이 들어가는 경로는 쓰지 않지만, 만약 들어가도 새지 않게 지운다.
    for (const k of [...u.searchParams.keys()]) {
      if (/key|token|secret|apikey/i.test(k)) u.searchParams.set(k, '(생략)');
    }
    return `${u.origin}${u.pathname}${u.search}`;
  } catch { return '(잘못된 URL)'; }
}

export async function request(spec: RequestSpec): Promise<unknown> {
  const { url, method = 'GET', headers = {}, body, source, validate } = spec;
  const retries = maxRetries();
  const timeout = timeoutMs();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { accept: 'application/json', ...headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      lastErr = err;
      // 연결 실패는 재시도 가치가 있다. 마지막 시도까지 실패하면 오류로 올린다.
      if (attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
      throw new ToolError('network_error',
        `${source} 에 연결하지 못했다 (${retries + 1}회 시도)`,
        { source, url: safeUrl(url), detail: err instanceof Error ? err.message : String(err) });
    }

    const text = await res.text();
    const parsed: unknown = text ? safeParse(text) : null;

    if (res.ok) {
      if (validate && !validate(parsed)) {
        throw new ToolError('upstream_error',
          `${source} 가 예상과 다른 형태를 돌려줬다. 빈 목록으로 뭉개지 않고 오류로 올린다`,
          { source, url: safeUrl(url), status: res.status, upstream: brief(parsed) });
      }
      return parsed;
    }

    // 4xx 는 대부분 재시도가 소용없다. 429 만 예외다.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 0);
      if (attempt < retries) { await sleep(Math.max(1000, retryAfter * 1000)); continue; }
      throw new ToolError('rate_limited', `${source} 가 호출 한도를 알렸다`, {
        source, url: safeUrl(url), retry_after_seconds: retryAfter || null,
        reset: res.headers.get('x-ratelimit-reset'),
      });
    }
    if (res.status === 401) {
      throw new FatalToolError('auth_failed',
        `${source} 자격증명이 거절됐다. .env.local 의 토큰을 확인한다 (값은 여기 남기지 않는다)`,
        { source, url: safeUrl(url), status: res.status, upstream: brief(parsed) });
    }
    if (res.status === 403) {
      throw new FatalToolError('scope_denied',
        `${source} 가 권한 부족으로 거절했다. 토큰 범위를 확인한다`,
        { source, url: safeUrl(url), status: res.status, upstream: brief(parsed) });
    }
    if (res.status === 404) {
      throw new FatalToolError('upstream_not_found', `${source} 에서 대상을 찾지 못했다`,
        { source, url: safeUrl(url), status: res.status, upstream: brief(parsed) });
    }
    if (res.status >= 500 && attempt < retries) { await sleep(700 * (attempt + 1)); continue; }

    throw new ToolError('upstream_error', `${source} 가 ${res.status} 를 돌려줬다`,
      { source, url: safeUrl(url), status: res.status, upstream: brief(parsed) });
  }

  throw new ToolError('network_error', `${source} 호출이 끝내 실패했다`,
    { source, detail: lastErr instanceof Error ? lastErr.message : String(lastErr) });
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 500) }; }
}

/**
 * 목록이 페이지 상한에 꽉 차면 그 뒤가 잘렸을 수 있다.
 * `>` 가 아니라 `>=` 다 — 상한과 같은 길이가 잘림의 신호다.
 */
export function pageMayBeTruncated(length: number, perPage: number): boolean {
  return length >= perPage;
}

/** 상류 응답을 그대로 흘리지 않고 사람이 읽을 만큼만 남긴다. */
function brief(parsed: unknown): unknown {
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    const e = o.error;
    if (e && typeof e === 'object') return e;
    if (o.message || o.code || o.hint) return { message: o.message, code: o.code, hint: o.hint };
  }
  return undefined;
}

/**
 * live 모드에 필요한 환경변수를 확인한다.
 * **이름만** 다룬다 — 값은 읽어서 어디에도 기록하지 않는다.
 */
export function requireEnv(tool: string, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) out[n] = v.trim(); else missing.push(n);
  }
  if (missing.length) {
    throw new FatalToolError('credentials_missing',
      `${tool} 을 live 모드로 부르려면 .env.local 에 ${missing.join(', ')} 가 필요하다`,
      { tool, missing, note: '값은 사람이 직접 넣는다. 이 오류에는 값이 담기지 않는다' });
  }
  return out;
}
