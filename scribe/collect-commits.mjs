// §6 커밋 수집기 — .env REPOS 화이트리스트만(개인 리포. 회사 리포 금지). 리포당 새 커밋을 commit_digest 1건으로 적립.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { appendEvent } from '../collectors/ledger-append.mjs';
import { nowISOKST } from '../collectors/lib/kst.mjs';
import { expandHome } from '../collectors/lib/paths.mjs';
import { findSecret } from '../collectors/lib/secrets.mjs';

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIRST_RUN_LIMIT = 20;
const DETAIL_LIMIT = 600;

export async function collectCommits({
  repos = [],
  ledgerDir = process.env.LEDGER_DIR,
  storeDir = path.join(REPO_ROOT, 'store', 'scribe'),
  log = console.log,
} = {}) {
  const counters = { reposProcessed: 0, reposSkipped: 0, digestsWritten: 0, writeFailures: 0, ledgerSkipped: 0, rejectedDigests: 0 };
  await mkdir(storeDir, { recursive: true });
  const cursorFile = path.join(storeDir, 'commit-cursor.json');
  let cursor = {};
  try {
    cursor = JSON.parse(await readFile(cursorFile, 'utf8'));
  } catch {
    cursor = {};
  }

  for (const repoRaw of repos) {
    const repo = path.resolve(expandHome(repoRaw));
    let head;
    try {
      head = (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    } catch (err) {
      counters.reposSkipped += 1; // R3
      log(`[commits] skip ${repo}: ${String(err.message).split('\n')[0]}`);
      continue;
    }
    counters.reposProcessed += 1;
    const last = cursor[repo];
    if (last === head) continue;

    let logOut;
    try {
      const range = last ? [`${last}..HEAD`] : ['-n', String(FIRST_RUN_LIMIT)];
      logOut = (await run('git', ['-C', repo, 'log', '--no-merges', '--pretty=format:%h %s', ...range])).stdout.trim();
    } catch {
      // 커서 SHA가 히스토리에 없음(rebase·force push) — 최근 커밋으로 재시작
      logOut = (await run('git', ['-C', repo, 'log', '--no-merges', '--pretty=format:%h %s', '-n', String(FIRST_RUN_LIMIT)])).stdout.trim();
    }
    const subjects = logOut ? logOut.split('\n') : [];
    if (subjects.length === 0) {
      cursor[repo] = head;
      continue;
    }

    // 시크릿성 서브젝트는 절단 전에 통째로 마스킹 — 절단이 패턴을 반쪽 내 스캔을 피하는 경로 차단(§12)
    const masked = subjects.map((s) => (findSecret(s) ? '[redacted: secret-like subject]' : s.slice(0, 100)));
    const digestEvent = (detail) => ({
      ts: nowISOKST(),
      source: 'scribe',
      kind: 'commit_digest',
      title: `${path.basename(repo)}: ${subjects.length} commits`,
      detail,
    });

    let r = await appendEvent(digestEvent(masked.join('; ').slice(0, DETAIL_LIMIT)), { ledgerDir });
    if (r.rejected) {
      // 거부는 결정적 실패 — 같은 내용 재시도는 영원히 같다. 전체 마스킹으로 1회 재시도.
      counters.rejectedDigests += 1;
      log(`[commits] digest rejected (${repo}): ${r.reason} — 마스킹 재시도`);
      r = await appendEvent(digestEvent('[redacted: digest rejected by secret scan]'), { ledgerDir });
    }
    if (r.ok) {
      counters.digestsWritten += 1;
      cursor[repo] = head;
    } else if (r.skipped) {
      counters.ledgerSkipped += 1; // R3 — LEDGER_DIR 미설정. 커서 유보: 원장이 생기면 재수집
    } else {
      counters.writeFailures += 1; // R3
      log(`[commits] ledger write failed (${repo}): ${r.reason}`);
      if (r.rejected) cursor[repo] = head; // 마스킹 후에도 거부면 재시도 무의미 — 영구 정지 대신 전진
    }
  }

  await writeFile(`${cursorFile}.tmp`, JSON.stringify(cursor, null, 2) + '\n', 'utf8');
  await rename(`${cursorFile}.tmp`, cursorFile);

  // 자기 카운터를 원장 note로 남겨 §6 다이제스트가 읽을 수 있게 한다 (R3 — 로그 파일은 소비 경로가 아니다)
  await appendEvent(
    {
      ts: nowISOKST(),
      source: 'scribe',
      kind: 'note',
      title: 'commit collector summary',
      detail:
        `processed=${counters.reposProcessed} skipped=${counters.reposSkipped} digests=${counters.digestsWritten} ` +
        `write_failures=${counters.writeFailures} rejected=${counters.rejectedDigests} ledger_skipped=${counters.ledgerSkipped}`,
    },
    { ledgerDir }
  );
  return counters;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadDotEnv, banner } = await import('../boot/env.mjs');
  loadDotEnv();
  banner('commit-collector');
  const repos = (process.env.REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (repos.length === 0) console.error('[commits] REPOS 화이트리스트가 비어 있다 — 수집 건너뜀');
  const c = await collectCommits({ repos });
  console.log(
    `[commits] done processed=${c.reposProcessed} R3: skipped=${c.reposSkipped} ` +
      `digests=${c.digestsWritten} write_failures=${c.writeFailures} rejected=${c.rejectedDigests} ledger_skipped=${c.ledgerSkipped}`
  );
  process.exit(0);
}
