// R1: env 부트 모듈 — 모든 CLI 엔트리의 첫 import여야 한다.
// 모듈-로드 시점에 env를 읽는 코드를 만들지 않는 것이 원칙이고, 이 모듈은 .env를 process.env로 승격만 한다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayKST } from '../collectors/lib/kst.mjs';
import { expandHome } from '../collectors/lib/paths.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// .env 파싱: KEY=VALUE 줄만, 이미 설정된 env는 덮지 않는다. dotenv 의존성 없이 최소 구현.
// NC_ENV_FILE로 파일 위치를 바꿀 수 있다(테스트·다중 배포).
export function loadDotEnv(file = process.env.NC_ENV_FILE ?? path.join(REPO_ROOT, '.env'), env = process.env) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return env;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, rawValue] = m;
    if (env[key] !== undefined) continue;
    env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

// R2: 기동 배너 — 프로세스가 "해석한 대상"을 1줄로 밝힌다.
export function banner(component, { env = process.env, log = console.log } = {}) {
  const ledger = env.LEDGER_DIR ? path.resolve(expandHome(env.LEDGER_DIR)) : '(unset)';
  const channels = [];
  if (env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT_ID) channels.push('telegram');
  if (env.SLACK_WEBHOOK_URL) channels.push('slack');
  const notifyTo = channels.length ? channels.join('+') : 'console-fallback';
  const line = `[boot] component=${component} LEDGER_DIR=${ledger} notify=${notifyTo} todayKST=${todayKST()}`;
  log(line);
  return line;
}

export { REPO_ROOT };
