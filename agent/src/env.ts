/**
 * `.env.local` 로더. 화면(app/lib/runner.ts · publish.ts · mode.ts)이 쓴다.
 *
 * 예전에는 실행기 세 곳에 같은 정규식이 복사돼 있었다. 복사본은 고칠 때 한 곳이 빠진다.
 *
 * 규칙:
 *   - 이미 설정된 환경변수는 덮어쓰지 않는다 (실행 환경이 우선이다)
 *   - 빈 줄·`#` 주석 줄은 건너뛴다
 *   - 값은 첫 `=` 뒤 전부다 (`=` 를 포함한 값도 깨지지 않는다)
 *   - 감싸는 따옴표 한 겹만 벗긴다. 짝이 맞을 때만 (`"a'b` 는 그대로 둔다)
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 한 줄을 파싱한다. 주석·빈 줄·키가 아니면 null. */
export function parseEnvLine(line: string): [string, string] | null {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const eq = t.indexOf('=');
  if (eq <= 0) return null;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if (!/^[A-Z0-9_]+$/.test(k)) return null;
  if (v.length >= 2
    && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1);
  }
  return [k, v];
}

/**
 * `.env.local` 을 읽어 비어 있는 환경변수만 채운다.
 * @param dir `.env.local` 이 있는 폴더 (보통 저장소 루트)
 */
export function loadEnvLocal(dir: string): void {
  const p = resolve(dir, '.env.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [k, v] = parsed;
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/**
 * `.env.local` 의 값을 **파일 그대로** 읽는다. process.env 를 거치지 않는다.
 *
 * 왜 따로 필요한가: `loadEnvLocal` 은 이미 설정된 환경변수를 덮어쓰지 않는다.
 * 그래서 서버가 뜬 뒤 파일을 고치면 process.env 에는 **낡은 값**이 남는다.
 * 실행 모드처럼 «파일이 정본» 인 설정은 이걸로 읽어야 화면과 실제가 어긋나지 않는다.
 * (실제로 파일을 fixture 로 바꿨는데 화면이 계속 live 라고 말한 적이 있다.)
 */
export function readEnvLocal(dir: string, key: string): string | undefined {
  const p = resolve(dir, '.env.local');
  if (!existsSync(p)) return undefined;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const parsed = parseEnvLine(line);
    if (parsed && parsed[0] === key) return parsed[1];
  }
  return undefined;
}
