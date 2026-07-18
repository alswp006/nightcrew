// §2.4 계약 A 읽기 + 소비자 커서. 읽기 전용 — 원장 파일을 절대 수정하지 않는다.
import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome } from './lib/paths.mjs';

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STORE = path.join(REPO_ROOT, 'store', 'cursors');

// cursor = { file: 'YYYY-MM-DD.jsonl', line: <소비한 줄 수> } | null(처음부터)
export async function readEvents({ ledgerDir = process.env.LEDGER_DIR, cursor = null } = {}) {
  const out = { events: [], parseFailures: 0, parseFailureLines: [], readFailures: 0, cursor: cursor ?? null };
  ledgerDir = expandHome(ledgerDir);
  if (!ledgerDir) return out;

  let names;
  try {
    names = (await readdir(ledgerDir)).filter((n) => DAY_FILE.test(n)).sort();
  } catch {
    return out; // 원장 부재 → 빈 결과 (원칙 2)
  }

  for (const name of names) {
    if (cursor?.file && name < cursor.file) continue;
    const skipLines = cursor?.file === name ? cursor.line : 0;
    let text;
    try {
      text = await readFile(path.join(ledgerDir, name), 'utf8');
    } catch {
      // R3: 반드시 센다. 커서가 실패 파일을 지나쳐 전진하면 그 파일의 이벤트가
      // 영구 미소비되므로(§2.4 멱등 계약 위반) 여기서 멈춘다 — 다음 실행이 재시도한다.
      out.readFailures += 1;
      break;
    }
    // 개행으로 끝나지 않는 마지막 조각은 append 진행 중인 미완성 줄 — 소비·커서 계산에서 제외
    const hasPartialTail = text.length > 0 && !text.endsWith('\n');
    const complete = hasPartialTail ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
    const lines = complete.split('\n').filter((l) => l.trim().length > 0);
    for (let i = skipLines; i < lines.length; i++) {
      try {
        out.events.push({ event: JSON.parse(lines[i]), file: name, line: i + 1 });
      } catch {
        out.parseFailures += 1; // R3: 건너뛰되 반드시 센다
        out.parseFailureLines.push({ file: name, line: i + 1 }); // 소비자가 중복 없이 누적 집계할 수 있게 위치 포함
      }
    }
    out.cursor = { file: name, line: lines.length };
    if (hasPartialTail) break; // 쓰는 중인 파일 뒤로는 전진하지 않는다
  }
  return out;
}

export async function loadCursor(consumer, { storeDir = DEFAULT_STORE } = {}) {
  const file = path.join(storeDir, `${consumer}.json`);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[ledger-read] cursor load failed (${consumer}): ${err.message}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    console.error(`[ledger-read] corrupt cursor (${consumer}) — resetting to full re-read`);
    return null;
  }
}

export async function saveCursor(consumer, cursor, { storeDir = DEFAULT_STORE } = {}) {
  if (!cursor) return;
  await mkdir(storeDir, { recursive: true });
  const file = path.join(storeDir, `${consumer}.json`);
  // 프로세스 킬로 반쯤 쓰인 커서가 남지 않게 tmp+rename 원자 교체
  await writeFile(`${file}.tmp`, JSON.stringify(cursor) + '\n', 'utf8');
  await rename(`${file}.tmp`, file);
}
