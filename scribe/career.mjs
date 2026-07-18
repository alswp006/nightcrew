// §6 경력 작가 (Scribe Phase 2). 성과성 이벤트(deploy·heal_done)를 후보로 적립하고,
// 사람의 확인 답장([x]=승격, [s]=폐기 — §6의 유일한 사람 입력 지점)을 처리해 경력 원장에 쓴다.
// SCRIBE_SPEC.md 부재(Q8)로 §6 요지를 원본 삼아 구현 — 상세 명세 확보 시 개정.
import path from 'node:path';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readEvents, loadCursor, saveCursor } from '../collectors/ledger-read.mjs';
import { appendEvent } from '../collectors/ledger-append.mjs';
import { todayKST, nowISOKST } from '../collectors/lib/kst.mjs';
import { sendNotify } from '../notify/notify.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATE_KINDS = new Set(['deploy', 'heal_done']);
const PENDING_HEADER =
  '# 경력 후보 — 확인 답장: `[ ]`를 `[x]`로 바꾸면 다음 실행에서 경력 원장(ledger.md)에 승격, `[s]`면 폐기\n\n';
const ENTRY_RE = /^- \[([ xsXS])\] (\S+) \| (\S+) \| (.+)$/;

// 사람이 손으로 고치는 유일한 파일이다 — 대소문자를 관용하고, 형식이 어긋난 줄은
// 지우지 말고 보존한다(무음 데이터 유실 금지, R3).
function parsePending(text) {
  const entries = [];
  const malformed = [];
  for (const l of text.split('\n')) {
    const m = ENTRY_RE.exec(l);
    if (m) {
      entries.push({ mark: m[1].toLowerCase(), id: m[2], date: m[3], text: m[4] });
    } else if (l.trim() && !l.startsWith('#')) {
      malformed.push(l);
    }
  }
  return { entries, malformed };
}

const entryLine = (e) => `- [${e.mark}] ${e.id} | ${e.date} | ${e.text}`;

export async function runCareer({
  ledgerDir = process.env.LEDGER_DIR,
  careerDir = path.join(REPO_ROOT, 'career'),
  cursorDir = path.join(REPO_ROOT, 'store', 'cursors'),
  cursorName = 'scribe-career',
  env = process.env,
  notifyImpl,
  now = new Date(),
  log = console.log,
} = {}) {
  const notify = notifyImpl ?? ((text) => sendNotify(text, { env }));
  const counters = { promoted: 0, discarded: 0, newCandidates: 0, notifyFailures: 0, writeFailures: 0, parseFailures: 0, malformedLines: 0 };
  const pendingFile = path.join(careerDir, 'pending.md');
  const ledgerFile = path.join(careerDir, 'ledger.md');

  // 1) 확인 답장 처리 — [x] 승격, [s] 폐기, [ ] 유지
  let entries = [];
  let malformed = [];
  let pendingExisted = false;
  try {
    ({ entries, malformed } = parsePending(await readFile(pendingFile, 'utf8')));
    pendingExisted = true;
  } catch {
    // pending 없음 — 첫 실행
  }
  counters.malformedLines = malformed.length; // R3
  if (malformed.length) log(`[career] 형식이 어긋난 줄 ${malformed.length}건 — 보존만 하고 처리하지 않는다`);

  // 이미 승격된 id는 다시 승격하지 않는다 — 부분 실패 재실행에서 중복 방지
  let existingLedger = '';
  try {
    existingLedger = await readFile(ledgerFile, 'utf8');
  } catch {
    // 원장 없음 — 첫 승격
  }
  const remaining = [];
  const promotedLines = [];
  for (const e of entries) {
    if (e.mark === 'x') {
      if (existingLedger.includes(`<!-- ${e.id} -->`)) {
        counters.promoted += 1; // 이미 승격됨 — pending에서만 제거
        continue;
      }
      promotedLines.push(`- ${e.date} ${e.text} (확정 ${todayKST(now)}) <!-- ${e.id} -->`);
      counters.promoted += 1;
    } else if (e.mark === 's') {
      counters.discarded += 1;
    } else {
      remaining.push(e);
    }
  }

  // 2) 원장에서 새 후보 소비 (§2.4 멱등 커서)
  const cursorStore = { storeDir: cursorDir };
  const cursor = await loadCursor(cursorName, cursorStore);
  const r = await readEvents({ ledgerDir, cursor });
  counters.parseFailures = r.parseFailures;
  const known = new Set(remaining.map((e) => e.id));
  for (const item of r.events) {
    const ev = item.event;
    if (!CANDIDATE_KINDS.has(ev.kind)) continue;
    const id = `${item.file}:${item.line}`;
    if (known.has(id)) continue;
    known.add(id);
    remaining.push({ mark: ' ', id, date: (ev.ts ?? '').slice(0, 10) || todayKST(now), text: ev.title ?? ev.kind });
    counters.newCandidates += 1;
  }

  // 3) 파일 기록 — 성공 후에만 커서 전진 (실패 시 다음 실행이 재시도)
  try {
    if (promotedLines.length) {
      await mkdir(careerDir, { recursive: true });
      await appendFile(ledgerFile, promotedLines.join('\n') + '\n', 'utf8');
    }
    if (pendingExisted || remaining.length) {
      await mkdir(careerDir, { recursive: true });
      const body = remaining.map(entryLine).join('\n') + (remaining.length ? '\n' : '');
      const preserved = malformed.length ? malformed.join('\n') + '\n' : '';
      await writeFile(pendingFile, PENDING_HEADER + body + preserved, 'utf8');
    }
    await saveCursor(cursorName, r.cursor, cursorStore);
  } catch (err) {
    counters.writeFailures += 1; // R3
    log(`[career] write failed: ${err.message}`);
  }

  // 4) 새 후보가 있을 때만 확인 요청 1건
  if (counters.newCandidates > 0) {
    try {
      const n = await notify(
        `[Scribe] 경력 후보 ${counters.newCandidates}건 — career/pending.md에서 확인 답장([x]/[s])을 남겨주세요`
      );
      if (!n?.ok) counters.notifyFailures += 1; // R3
    } catch {
      counters.notifyFailures += 1;
    }
  }

  // R3: 자기 카운터를 원장 note로 남겨 §6 다이제스트에 도달시킨다
  await appendEvent(
    {
      ts: nowISOKST(now),
      source: 'scribe',
      kind: 'note',
      title: 'career run summary',
      detail:
        `new=${counters.newCandidates} promoted=${counters.promoted} discarded=${counters.discarded} ` +
        `malformed=${counters.malformedLines} parse_failures=${counters.parseFailures} ` +
        `write_failures=${counters.writeFailures} notify_failures=${counters.notifyFailures}`,
    },
    { ledgerDir }
  );

  log(
    `[career] done new=${counters.newCandidates} promoted=${counters.promoted} discarded=${counters.discarded} ` +
      `R3: malformed=${counters.malformedLines} parse_failures=${counters.parseFailures} ` +
      `write_failures=${counters.writeFailures} notify_failures=${counters.notifyFailures}`
  );
  return counters;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadDotEnv, banner } = await import('../boot/env.mjs');
  loadDotEnv();
  banner('scribe-career');
  await runCareer();
  process.exit(0);
}
