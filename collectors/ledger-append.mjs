// §2.3 계약 A 단일 관문. CLI(stdin/인자)와 import 모듈 겸용.
// 성공/스킵 exit 0 · 검증/시크릿 거부 exit 2 · 쓰기 실패 exit 1 — 어느 경우에도 호출자를 crash시키지 않는다.
import { appendFile, mkdir, open, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateEvent } from './lib/schema.mjs';
import { findSecret } from './lib/secrets.mjs';
import { todayKST } from './lib/kst.mjs';
import { expandHome } from './lib/paths.mjs';

const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 3000;

// flock(2)은 Node 코어에 없다 — 계약의 요구는 "동시 쓰기 안전"이므로
// O_APPEND 단일 write + 락파일(mutual exclusion, stale 회수)로 동일 보장을 구현한다.
// deadline 검사는 루프 선두에 둔다: 삭제 불가 stale 락 등 어떤 경로로도 무한 루프가 되지 않게.
async function withFileLock(file, fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS, retryMs = LOCK_RETRY_MS } = {}) {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`lock timeout: ${lockPath}`);
    try {
      const fh = await open(lockPath, 'wx');
      await fh.close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > staleMs) await unlink(lockPath).catch(() => {});
      } catch {
        // 락이 그 사이 사라짐 — 다음 루프에서 획득 시도
      }
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

export async function appendEvent(event, { ledgerDir = process.env.LEDGER_DIR, now = new Date(), lockTimeoutMs } = {}) {
  ledgerDir = expandHome(ledgerDir);
  if (!ledgerDir) {
    return { ok: false, skipped: true, reason: 'LEDGER_DIR is not set — ledger write skipped' };
  }
  const v = validateEvent(event);
  if (!v.ok) return { ok: false, rejected: true, reason: v.reason };
  // §12는 필드를 한정하지 않는다 — 추가 필드·refs로 스캔을 우회할 수 없게 직렬화 전체를 본다
  const hit = findSecret(JSON.stringify(event));
  if (hit) return { ok: false, rejected: true, reason: `secret pattern (${hit}) found in event — rejected` };
  const file = path.join(ledgerDir, `${todayKST(now)}.jsonl`);
  try {
    await mkdir(ledgerDir, { recursive: true });
    await withFileLock(file, () => appendFile(file, JSON.stringify(event) + '\n', 'utf8'), {
      ...(lockTimeoutMs ? { timeoutMs: lockTimeoutMs } : {}),
    });
    return { ok: true, file };
  } catch (err) {
    return { ok: false, reason: `ledger write failed: ${err.message}` };
  }
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  // R1: .env 부트가 첫 동작 — cron/ssh 비대화형 셸에는 전역 export가 없다. R2: 해석된 대상 배너.
  const { loadDotEnv, banner } = await import('../boot/env.mjs');
  loadDotEnv();
  banner('ledger-append');

  const raw = process.argv[2] ?? (await readStdin());
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    console.error('[ledger-append] invalid JSON input');
    process.exit(2);
  }
  const r = await appendEvent(event);
  if (r.ok) return;
  console.error(`[ledger-append] ${r.reason}`);
  if (r.skipped) process.exit(0); // §2.3: LEDGER_DIR 미설정 → 경고 1줄 + exit 0
  process.exit(r.rejected ? 2 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
