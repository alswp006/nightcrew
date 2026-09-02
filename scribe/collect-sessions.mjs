// §6 세션 로그 수집기 — 데스크톱 Claude Code 전사(~/.claude/projects/**/*.jsonl)를 읽어
// 세션당 session_digest 1건으로 적립한다. 커밋 수집기(collect-commits.mjs)의 형제.
//
// ── 왜 원문을 원장에 넣지 않나 (기본 detail=meta) ──
// 전사는 이미 디스크에 있다. 원장에 또 담으면 노출면만 넓어진다 — 원장은 위성으로 rsync되고
// 작가 3인이 읽는다. §6 민감도 등급이 "일기·세션 로그 = 로컬 엔진 전용, 원문 외부 전송 금지"인
// 이유가 그것이고, 여기서는 한 걸음 더 간다: **애초에 원문을 적립하지 않는다.**
// 기본은 메타데이터만(언제·어느 프로젝트·몇 턴·무슨 도구 몇 번). 대화 내용은 0바이트다.
// 일기가 쓸 소재가 필요하면 SESSIONS_DETAIL=topics로 **첫 사용자 프롬프트 한 줄만** 연다
// (마스킹·절단 후). 전사 전체를 담는 모드는 만들지 않는다 — 필요를 없애는 쪽이 권한을 여는
// 쪽보다 낫다(ai-factory CLAUDE.md의 rm 원칙과 같은 계열).
//
// ── 왜 델타인가 ──
// 세션 파일은 재개(resume)로 며칠~몇 주에 걸쳐 계속 append된다(실측: 한 파일이 08-02→09-02).
// "파일 하나 = 다이제스트 하나"로 잡으면 첫날 한 번 쓰고 영원히 조용하다. 커서는 세션별로
// **소비한 줄 수**를 들고, 매 실행은 새로 늘어난 줄만 요약한다.
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { readdir, readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { appendEvent } from '../collectors/ledger-append.mjs';
import { nowISOKST } from '../collectors/lib/kst.mjs';
import { expandHome } from '../collectors/lib/paths.mjs';
import { findSecret } from '../collectors/lib/secrets.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DETAIL_LIMIT = 600;      // 이벤트 8KB 상한(§2.2)에 한참 못 미치게 — 원장은 요약이지 사본이 아니다
const TOPIC_LIMIT = 160;       // topics 모드에서 싣는 첫 프롬프트 길이
const TOOL_TOP_N = 8;
// 첫 실행 백필 상한(일). collect-commits의 FIRST_RUN_LIMIT=20과 같은 자리 —
// 없으면 켜는 날 과거 전 세션이 **오늘 원장에** 쏟아지고(모든 이벤트의 ts가 now다)
// 그날 개발일지가 몇 달치 요약으로 뒤덮인다. 처음 보는 세션이 이보다 오래됐으면
// 내용은 안 읽고 커서만 끝에 놓는다. 0이면 상한 없음(의도적 전체 백필).
const BACKFILL_DAYS = 14;

/** 사람이 친 턴인가 — tool_result는 user 타입으로 오지만 사람의 발화가 아니다(실측 2,212/2,321). */
export function isHumanTurn(entry) {
  if (entry?.type !== 'user' || entry?.isSidechain) return false;
  const c = entry?.message?.content;
  if (typeof c === 'string') return true;
  if (!Array.isArray(c)) return false;
  return c.some((b) => b && (b.type === 'text' || b.type === 'image'));
}

/** 첫 사람 턴에서 한 줄 주제를 뽑는다. 시크릿성이면 통째로 마스킹(절단이 패턴을 반쪽 내지 않게). */
export function topicOf(entry) {
  const c = entry?.message?.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (findSecret(text)) return '[redacted: secret-like prompt]';
  return text.slice(0, TOPIC_LIMIT);
}

/** cwd가 화이트리스트 안인가 — 경로 접두 일치(디렉터리 경계까지 확인해 /a가 /ab를 삼키지 않게). */
export function cwdAllowed(cwd, allow) {
  if (!cwd) return false;
  if (allow.length === 0) return false;
  const c = path.resolve(cwd);
  return allow.some((a) => {
    const base = path.resolve(expandHome(a));
    return c === base || c.startsWith(base + path.sep);
  });
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/** 줄 수만 센다(JSON 파싱 없음) — 백필 제외 세션의 커서를 끝에 놓기 위한 최소 비용 통과. */
async function countLines(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  try { for await (const _line of rl) n += 1; } finally { rl.close(); }
  return n;
}

/**
 * 세션 파일 하나의 **새 줄만** 훑어 집계한다. 파싱 실패 줄은 세고 넘어간다(R3) —
 * 한 줄이 깨졌다고 그 세션을 통째로 버리면 기록이 조용히 빈다.
 */
async function scanDelta(file, fromLine) {
  const agg = {
    lines: 0, humanTurns: 0, assistantTurns: 0, sidechain: 0, parseErrors: 0,
    tools: new Map(), cwd: '', branch: '', version: '', entrypoint: '',
    firstTs: '', lastTs: '', topic: '',
  };
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let idx = 0;
  try {
    for await (const line of rl) {
      idx += 1;
      if (idx <= fromLine) continue;
      agg.lines += 1;
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { agg.parseErrors += 1; continue; }
      if (o.cwd) agg.cwd = o.cwd;
      if (o.gitBranch) agg.branch = o.gitBranch;
      if (o.version) agg.version = o.version;
      if (o.entrypoint) agg.entrypoint = o.entrypoint;
      if (o.timestamp) { agg.firstTs ||= o.timestamp; agg.lastTs = o.timestamp; }
      if (o.isSidechain) agg.sidechain += 1;
      if (o.type === 'assistant') agg.assistantTurns += 1;
      if (isHumanTurn(o)) {
        agg.humanTurns += 1;
        if (!agg.topic) agg.topic = topicOf(o);
      }
      const content = o?.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_use' && b.name) agg.tools.set(b.name, (agg.tools.get(b.name) ?? 0) + 1);
        }
      }
    }
  } finally {
    rl.close();
  }
  return { agg, totalLines: idx };
}

export async function collectSessions({
  projectsDir = process.env.CLAUDE_PROJECTS_DIR || path.join(homedir(), '.claude', 'projects'),
  allowCwds = [],
  detail = process.env.SESSIONS_DETAIL === 'topics' ? 'topics' : 'meta',
  backfillDays = Number(process.env.SESSIONS_BACKFILL_DAYS ?? BACKFILL_DAYS),
  now = Date.now(),
  ledgerDir = process.env.LEDGER_DIR,
  storeDir = path.join(REPO_ROOT, 'store', 'scribe'),
  log = console.log,
} = {}) {
  const counters = {
    filesSeen: 0, filesSkippedCwd: 0, filesUnchanged: 0, filesBackfillSkipped: 0, digestsWritten: 0,
    parseErrors: 0, writeFailures: 0, rejectedDigests: 0, ledgerSkipped: 0, scanFailures: 0,
  };
  await mkdir(storeDir, { recursive: true });
  const cursorFile = path.join(storeDir, 'session-cursor.json');
  let cursor = {};
  try { cursor = JSON.parse(await readFile(cursorFile, 'utf8')); } catch { cursor = {}; }

  const root = path.resolve(expandHome(projectsDir));
  let dirs = [];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    // 전사 디렉터리가 없는 기계(위성 등)에서는 조용히 아무 일도 안 한다 — 설계 원칙 2.
    log(`[sessions] projects dir 없음 (${root}) — 수집 건너뜀`);
    return counters;
  }

  for (const dir of dirs) {
    let files = [];
    try {
      files = (await readdir(path.join(root, dir))).filter((f) => f.endsWith('.jsonl'));
    } catch { continue; }
    for (const f of files) {
      const file = path.join(root, dir, f);
      const sessionId = f.replace(/\.jsonl$/, '');
      counters.filesSeen += 1;

      // 커서보다 파일이 안 컸으면 훑지도 않는다 — 매일 도는 cron이 수십 MB를 재파싱하지 않게.
      const firstSight = cursor[sessionId] === undefined;
      const prev = cursor[sessionId] ?? { lines: 0, size: 0 };
      let st;
      try { st = await stat(file); } catch { counters.scanFailures += 1; continue; }
      const size = st.size;
      if (size === prev.size && prev.lines > 0) { counters.filesUnchanged += 1; continue; }

      // 처음 보는데 이미 오래된 세션 — 내용은 안 읽고 커서만 끝에 놓는다(백필 폭주 차단).
      // 판정은 mtime이다: 파일 안 타임스탬프를 보려면 어차피 전체를 훑어야 해서 비용이 목적과 어긋난다.
      // (clone·rsync로 mtime이 리셋된 기계라면 SESSIONS_BACKFILL_DAYS=0으로 전체 백필을 택하라.)
      if (firstSight && backfillDays > 0 && now - st.mtimeMs > backfillDays * 86_400_000) {
        counters.filesBackfillSkipped += 1;
        try {
          cursor[sessionId] = { lines: await countLines(file), size };
        } catch {
          counters.scanFailures += 1;
        }
        continue;
      }

      let scan;
      try {
        scan = await scanDelta(file, prev.lines);
      } catch (err) {
        counters.scanFailures += 1; // R3
        log(`[sessions] scan 실패 (${sessionId}): ${String(err.message).split('\n')[0]}`);
        continue;
      }
      const { agg, totalLines } = scan;
      counters.parseErrors += agg.parseErrors;

      if (agg.lines === 0) { counters.filesUnchanged += 1; cursor[sessionId] = { lines: totalLines, size }; continue; }
      if (!cwdAllowed(agg.cwd, allowCwds)) {
        counters.filesSkippedCwd += 1;
        // 화이트리스트 밖은 **커서만 전진**시킨다 — 내용은 한 글자도 안 남기고, 다음 실행이 또 훑지 않게.
        cursor[sessionId] = { lines: totalLines, size };
        continue;
      }
      // 사람 턴이 0인 델타(도구 결과만 늘어난 꼬리)는 적립하지 않는다 — 일지에 쓸 게 없다.
      if (agg.humanTurns === 0 && agg.assistantTurns === 0) {
        cursor[sessionId] = { lines: totalLines, size };
        continue;
      }

      const project = path.basename(agg.cwd || dir);
      const tools = [...agg.tools.entries()].sort((a, b) => b[1] - a[1]);
      const toolStr = tools.slice(0, TOOL_TOP_N).map(([n, c]) => `${n}×${c}`).join(' ');
      const toolTotal = tools.reduce((s, [, c]) => s + c, 0);
      const durMs = agg.firstTs && agg.lastTs ? Date.parse(agg.lastTs) - Date.parse(agg.firstTs) : 0;

      const parts = [
        `cwd=${agg.cwd}`,
        agg.branch ? `branch=${agg.branch}` : '',
        `dur=${fmtDuration(durMs)}`,
        `turns=u${agg.humanTurns}/a${agg.assistantTurns}`,
        agg.sidechain ? `sidechain=${agg.sidechain}` : '',
        `tools=${toolTotal}${toolStr ? ` (${toolStr})` : ''}`,
        agg.version ? `cc=${agg.version}` : '',
      ].filter(Boolean);
      if (detail === 'topics' && agg.topic) parts.push(`topic="${agg.topic}"`);

      const digestEvent = (d) => ({
        ts: nowISOKST(),
        source: 'scribe',
        kind: 'session_digest',
        title: `${project}: ${agg.humanTurns} turns, ${toolTotal} tool calls`,
        detail: d,
      });

      let r = await appendEvent(digestEvent(parts.join(' ').slice(0, DETAIL_LIMIT)), { ledgerDir });
      if (r.rejected) {
        // 거부는 결정적이다 — 같은 내용 재시도는 영원히 같다. 메타만 남기고 1회 재시도(commits와 같은 계약).
        counters.rejectedDigests += 1;
        log(`[sessions] digest rejected (${sessionId}): ${r.reason} — 메타만으로 재시도`);
        r = await appendEvent(digestEvent(`cwd=[redacted] dur=${fmtDuration(durMs)} turns=u${agg.humanTurns}/a${agg.assistantTurns} tools=${toolTotal}`), { ledgerDir });
      }
      if (r.ok) {
        counters.digestsWritten += 1;
        cursor[sessionId] = { lines: totalLines, size };
      } else if (r.skipped) {
        counters.ledgerSkipped += 1; // R3 — LEDGER_DIR 미설정. 커서 유보: 원장이 생기면 재수집
      } else {
        counters.writeFailures += 1; // R3
        log(`[sessions] ledger write failed (${sessionId}): ${r.reason}`);
        if (r.rejected) cursor[sessionId] = { lines: totalLines, size }; // 마스킹 후에도 거부면 전진
      }
    }
  }

  await writeFile(`${cursorFile}.tmp`, JSON.stringify(cursor, null, 2) + '\n', 'utf8');
  await rename(`${cursorFile}.tmp`, cursorFile);

  // 자기 카운터를 원장 note로 — §6 다이제스트(R3)가 읽는다. 로그 파일은 소비 경로가 아니다.
  await appendEvent(
    {
      ts: nowISOKST(),
      source: 'scribe',
      kind: 'note',
      title: 'session collector summary',
      detail:
        `detail=${detail} files=${counters.filesSeen} unchanged=${counters.filesUnchanged} ` +
        `skipped_cwd=${counters.filesSkippedCwd} backfill_skipped=${counters.filesBackfillSkipped} ` +
        `digests=${counters.digestsWritten} ` +
        `parse_errors=${counters.parseErrors} scan_failures=${counters.scanFailures} ` +
        `write_failures=${counters.writeFailures} rejected=${counters.rejectedDigests} ledger_skipped=${counters.ledgerSkipped}`,
    },
    { ledgerDir }
  );
  return counters;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadDotEnv, banner } = await import('../boot/env.mjs');
  loadDotEnv();
  banner('session-collector');
  const allowCwds = (process.env.SESSION_CWDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowCwds.length === 0) console.error('[sessions] SESSION_CWDS 화이트리스트가 비어 있다 — 수집 건너뜀');
  const c = await collectSessions({ allowCwds });
  console.log(
    `[sessions] done files=${c.filesSeen} digests=${c.digestsWritten} R3: unchanged=${c.filesUnchanged} ` +
      `skipped_cwd=${c.filesSkippedCwd} backfill_skipped=${c.filesBackfillSkipped} ` +
      `parse_errors=${c.parseErrors} scan_failures=${c.scanFailures} ` +
      `write_failures=${c.writeFailures} rejected=${c.rejectedDigests} ledger_skipped=${c.ledgerSkipped}`
  );
  process.exit(0);
}
