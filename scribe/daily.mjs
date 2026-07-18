// §6 개발일지 작가 + 아침 1줄 스탠드업. 원장을 커서로 멱등 소비(§2.4)해
// 날짜별 캐시(store/scribe/{date}.json)에 (file,line) 키로 중복 없이 병합하고, 캐시에서 journal/{date}.md를 전체 재생성한다.
// journal 쓰기 실패 시 커서를 유보해 다음 실행이 재소비하는데, 캐시 병합이 멱등이라 중복 기록이 생기지 않는다.
import path from 'node:path';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readEvents, loadCursor, saveCursor } from '../collectors/ledger-read.mjs';
import { appendEvent } from '../collectors/ledger-append.mjs';
import { todayKST, nowISOKST } from '../collectors/lib/kst.mjs';
import { sendNotify } from '../notify/notify.mjs';
import { summarize, templateSummary } from './lib/summarize.mjs';
import { renderJournal } from './lib/render.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 캐시 = { entries: [{file, line, event}], parseFailures: [{file, line}] }
async function readCache(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(data)) return { entries: data.map((e) => ({ event: e })), parseFailures: [] };
    return { entries: data.entries ?? [], parseFailures: data.parseFailures ?? [] };
  } catch {
    return { entries: [], parseFailures: [] };
  }
}

function mergeByKey(existing, incoming, keyOf) {
  const seen = new Set(existing.map(keyOf).filter(Boolean));
  for (const item of incoming) {
    const key = keyOf(item);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    existing.push(item);
  }
}

export async function runDaily({
  ledgerDir = process.env.LEDGER_DIR,
  storeDir = path.join(REPO_ROOT, 'store', 'scribe'),
  journalDir = path.join(REPO_ROOT, 'journal'),
  cursorDir = path.join(REPO_ROOT, 'store', 'cursors'), // §2.4 규약 경로: store/cursors/{consumer}.json
  cursorName = 'scribe-daily',
  summarizer = 'auto',
  selfNote = true, // 자기 카운터를 원장 note로 남긴다 (R3 — 발송 실패도 다음 날 일지에 보이게)
  env = process.env,
  notifyImpl,
  now = new Date(),
  log = console.log,
} = {}) {
  const notify = notifyImpl ?? ((text) => sendNotify(text, { env }));
  const counters = { parseFailures: 0, readFailures: 0, notifyFailures: 0, journalWriteFailures: 0 };
  const cursorStore = { storeDir: cursorDir };

  const cursor = await loadCursor(cursorName, cursorStore);
  const r = await readEvents({ ledgerDir, cursor });
  counters.parseFailures = r.parseFailures;
  counters.readFailures = r.readFailures;

  // 새 이벤트·파싱 실패를 날짜별로 묶는다 (file = YYYY-MM-DD.jsonl)
  const byDay = new Map();
  const dayOf = (file) => file.slice(0, 10);
  for (const item of r.events) {
    const day = dayOf(item.file);
    if (!byDay.has(day)) byDay.set(day, { items: [], parseFailures: [] });
    byDay.get(day).items.push(item);
  }
  for (const pf of r.parseFailureLines) {
    const day = dayOf(pf.file);
    if (!byDay.has(day)) byDay.set(day, { items: [], parseFailures: [] });
    byDay.get(day).parseFailures.push(pf);
  }

  const daysWritten = [];
  await mkdir(storeDir, { recursive: true });
  for (const [day, incoming] of [...byDay.entries()].sort()) {
    const cacheFile = path.join(storeDir, `${day}.json`);
    const cache = await readCache(cacheFile);
    mergeByKey(cache.entries, incoming.items.map((i) => ({ file: i.file, line: i.line, event: i.event })), (x) =>
      x.file && x.line ? `${x.file}:${x.line}` : null
    );
    mergeByKey(cache.parseFailures, incoming.parseFailures, (x) => `${x.file}:${x.line}`);
    await writeFile(`${cacheFile}.tmp`, JSON.stringify(cache) + '\n', 'utf8');
    await rename(`${cacheFile}.tmp`, cacheFile);

    try {
      const dayEvents = cache.entries.map((x) => x.event);
      const summary = await summarize(dayEvents, { engine: summarizer, env, log: (engine) => log(`[scribe] summary engine: ${engine}`) });
      const md = renderJournal(
        day,
        dayEvents,
        { parseFailures: cache.parseFailures.length, readFailures: counters.readFailures },
        summary
      );
      await mkdir(journalDir, { recursive: true });
      await writeFile(path.join(journalDir, `${day}.md`), md, 'utf8');
      daysWritten.push(day);
    } catch (err) {
      counters.journalWriteFailures += 1; // R3
      log(`[scribe] journal write failed (${day}): ${err.message}`);
    }
  }

  // 커서는 일지 반영 성공 후에만 전진 — 실패 시 다음 실행이 재소비하고, 캐시 병합이 멱등이라 안전하다
  if (counters.journalWriteFailures === 0) {
    await saveCursor(cursorName, r.cursor, cursorStore);
  }

  // 아침 1줄 스탠드업(§6) — 밤새(오늘) 활동 + 어제 저녁 수집분(23:50 커밋 등)까지 창을 넓힌다.
  // R3 카운터: 자기 것 + 어제·오늘 공급자 요약 note들의 스킵/쓰기실패 합계.
  const today = todayKST(now);
  const yesterday = todayKST(new Date(now.getTime() - 24 * 3600 * 1000));
  const todayCache = await readCache(path.join(storeDir, `${today}.json`));
  const yesterdayCache = await readCache(path.join(storeDir, `${yesterday}.json`));
  const todayEvents = todayCache.entries.map((x) => x.event);
  const yesterdayEvents = yesterdayCache.entries.map((x) => x.event);
  let skipTotal = 0;
  let writeFailTotal = 0;
  for (const e of [...yesterdayEvents, ...todayEvents]) {
    if (e.kind !== 'note' || !/summary/i.test(e.title ?? '')) continue;
    skipTotal += Number(/(?:^|\s)skipped=(\d+)/.exec(e.detail ?? '')?.[1] ?? 0);
    writeFailTotal += Number(/write_failures=(\d+)/.exec(e.detail ?? '')?.[1] ?? 0);
  }
  const yCommits = yesterdayEvents.filter((e) => e.kind === 'commit_digest').length;
  const standup =
    `[Scribe] ${today} 스탠드업: ${templateSummary(todayEvents)}` +
    (yCommits ? ` · 어제 커밋 digest ${yCommits}건` : '') +
    ` · R3 parse=${counters.parseFailures} read=${counters.readFailures} journal_fail=${counters.journalWriteFailures} ` +
    `skip_total=${skipTotal} write_fail_total=${writeFailTotal}`;
  try {
    const n = await notify(standup);
    if (!n?.ok) counters.notifyFailures += 1; // R3
  } catch {
    counters.notifyFailures += 1;
  }

  if (selfNote) {
    await appendEvent(
      {
        ts: nowISOKST(now),
        source: 'scribe',
        kind: 'note',
        title: 'scribe standup summary',
        detail:
          `days=${daysWritten.length} parse_failures=${counters.parseFailures} read_failures=${counters.readFailures} ` +
          `journal_write_failures=${counters.journalWriteFailures} notify_failures=${counters.notifyFailures}`,
      },
      { ledgerDir }
    );
  }

  log(
    `[scribe] done days=${daysWritten.join(',') || '-'} R3: parse_failures=${counters.parseFailures} ` +
      `read_failures=${counters.readFailures} journal_write_failures=${counters.journalWriteFailures} ` +
      `notify_failures=${counters.notifyFailures}`
  );
  return { daysWritten, counters };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadDotEnv, banner } = await import('../boot/env.mjs');
  loadDotEnv();
  banner('scribe-daily');
  await runDaily();
  process.exit(0);
}
