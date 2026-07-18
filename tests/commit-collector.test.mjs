import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectCommits } from '../scribe/collect-commits.mjs';
import { readEvents } from '../collectors/ledger-read.mjs';

async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'nc-commits-'));
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

async function makeRepo() {
  const repo = await tmp();
  git(repo, 'init', '-q');
  await writeFile(path.join(repo, 'a.txt'), '1');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'feat: first');
  await writeFile(path.join(repo, 'a.txt'), '2');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fix: second');
  return repo;
}

test('화이트리스트 리포의 커밋을 commit_digest 1건으로 적립한다 (§6)', async () => {
  const repo = await makeRepo();
  const ledgerDir = await tmp();
  const storeDir = await tmp();

  const r = await collectCommits({ repos: [repo], ledgerDir, storeDir });
  assert.equal(r.digestsWritten, 1);

  const { events } = await readEvents({ ledgerDir });
  const digests = events.filter((x) => x.event.kind === 'commit_digest');
  assert.equal(digests.length, 1);
  const e = digests[0].event;
  assert.equal(e.source, 'scribe');
  assert.match(e.title, /2 commits?/);
  assert.match(e.detail, /feat: first/);
  assert.match(e.detail, /fix: second/);

  // R3→§6: 수집기 자기 카운터가 원장 note로 남아 다이제스트에 도달해야 한다
  const summary = events.find((x) => x.event.kind === 'note' && /commit collector summary/.test(x.event.title));
  assert.ok(summary, '수집기 요약 note 이벤트가 있어야 한다');
  assert.match(summary.event.detail, /skipped=0/);
});

test('멱등: 새 커밋이 없으면 이벤트를 다시 쓰지 않는다', async () => {
  const repo = await makeRepo();
  const ledgerDir = await tmp();
  const storeDir = await tmp();

  await collectCommits({ repos: [repo], ledgerDir, storeDir });
  const r2 = await collectCommits({ repos: [repo], ledgerDir, storeDir });
  assert.equal(r2.digestsWritten, 0);

  const { events } = await readEvents({ ledgerDir });
  assert.equal(events.filter((x) => x.event.kind === 'commit_digest').length, 1, '같은 커밋이 두 번 적립되면 안 된다');
});

test('증분: 새 커밋만 다음 digest에 담긴다', async () => {
  const repo = await makeRepo();
  const ledgerDir = await tmp();
  const storeDir = await tmp();

  await collectCommits({ repos: [repo], ledgerDir, storeDir });
  await writeFile(path.join(repo, 'b.txt'), '3');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'chore: third');

  const r = await collectCommits({ repos: [repo], ledgerDir, storeDir });
  assert.equal(r.digestsWritten, 1);
  const { events } = await readEvents({ ledgerDir });
  const last = events.filter((x) => x.event.kind === 'commit_digest').at(-1).event;
  assert.match(last.detail, /chore: third/);
  assert.ok(!last.detail.includes('feat: first'), '이미 적립한 커밋은 제외');
});

test('시크릿 서브젝트는 마스킹해 적립하고 커서는 전진한다 — 수집이 영구 정지하면 안 된다', async () => {
  const repo = await makeRepo();
  await writeFile(path.join(repo, 'c.txt'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fix: revoke leaked ghp_16C7e42F292c6912E7710c838347Ae178B4a token');
  const ledgerDir = await tmp();
  const storeDir = await tmp();

  const r = await collectCommits({ repos: [repo], ledgerDir, storeDir });
  assert.equal(r.digestsWritten, 1, '시크릿 서브젝트 때문에 digest 전체가 거부되면 안 된다');

  const { events } = await readEvents({ ledgerDir });
  const digest = events.filter((x) => x.event.kind === 'commit_digest')[0].event;
  assert.ok(!digest.detail.includes('ghp_'), '시크릿은 원장에 남으면 안 된다 (§12)');
  assert.match(digest.detail, /redacted/, '마스킹 흔적이 남아야 한다');
  assert.match(digest.detail, /feat: first/, '깨끗한 서브젝트는 보존');

  // 커서가 전진했으므로 다음 깨끗한 커밋은 정상 적립된다
  await writeFile(path.join(repo, 'd.txt'), 'y');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'feat: clean follow-up');
  const r2 = await collectCommits({ repos: [repo], ledgerDir, storeDir });
  assert.equal(r2.digestsWritten, 1);
  const last = (await readEvents({ ledgerDir })).events.filter((x) => x.event.kind === 'commit_digest').at(-1).event;
  assert.match(last.detail, /clean follow-up/);
  assert.ok(!last.detail.includes('redacted'), '이미 처리한 오염 커밋은 다음 digest에 없어야 한다');
});

test('R3: 없는 리포 경로는 건너뛰고 카운트한다', async () => {
  const ledgerDir = await tmp();
  const storeDir = await tmp();
  const r = await collectCommits({ repos: ['/nonexistent/repo'], ledgerDir, storeDir });
  assert.equal(r.reposSkipped, 1);
  assert.equal(r.digestsWritten, 0);
});
