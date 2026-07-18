import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDaily } from '../scribe/daily.mjs';
import { todayKST } from '../collectors/lib/kst.mjs';

async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'nc-daily-'));
}

const line = (o) => JSON.stringify(o) + '\n';
const T = todayKST();

async function seedLedger(dir) {
  const events = [
    { ts: `${T}T04:30:00+09:00`, source: 'sentinel', kind: 'heartbeat', title: 'sentinel run start' },
    { ts: `${T}T04:31:00+09:00`, source: 'sentinel', app: 'fac_demo', kind: 'run_pass', title: 'fac_demo 통과' },
    {
      ts: `${T}T04:32:00+09:00`,
      source: 'sentinel',
      app: 'fac_bad',
      kind: 'run_fail',
      title: 'fac_bad 실패 1건',
      detail: 'error_signature=fac_bad:result:blank',
    },
    {
      ts: `${T}T04:33:00+09:00`,
      source: 'sentinel',
      kind: 'note',
      title: 'sentinel run summary',
      detail: 'packs_run=2 skipped=1 parse_failures=0 write_failures=0 notify_failures=0 claude_skipped=0',
    },
    { ts: `${T}T23:50:00+09:00`, source: 'scribe', kind: 'commit_digest', title: 'nightcrew: 3 commits', detail: 'feat a; fix b; chore c' },
    {
      ts: `${T}T23:55:00+09:00`,
      source: 'scribe',
      kind: 'note',
      title: 'commit collector summary',
      detail: 'processed=2 skipped=1 digests=1 write_failures=0',
    },
  ];
  await writeFile(path.join(dir, `${T}.jsonl`), events.map(line).join('') + 'BROKEN LINE\n');
}

function setup(ledgerDir, storeDir, journalDir) {
  const notifications = [];
  return {
    opts: {
      ledgerDir,
      storeDir,
      journalDir,
      cursorDir: path.join(storeDir, 'cursors'),
      summarizer: 'template',
      selfNote: false, // 대부분의 테스트는 소비 멱등성 자체를 본다 — 자기 기록은 전용 테스트에서
      notifyImpl: async (text) => {
        notifications.push(text);
        return { ok: true };
      },
    },
    notifications,
  };
}

test('§13-2 완성 기준: daily 실행 → journal/오늘.md 생성 (R3 카운터 포함)', async () => {
  const ledgerDir = await tmp();
  const storeDir = await tmp();
  const journalDir = await tmp();
  await seedLedger(ledgerDir);
  const { opts, notifications } = setup(ledgerDir, storeDir, journalDir);

  const r = await runDaily({ ...opts, selfNote: true });
  assert.ok(r.daysWritten.includes(T));

  // R3: Scribe 자신의 발송·실패 카운터도 원장에 남아야 다음 날 일지·deadman이 볼 수 있다
  const { readEvents } = await import('../collectors/ledger-read.mjs');
  const { events } = await readEvents({ ledgerDir });
  const selfNote = events.find((e) => e.event.kind === 'note' && /scribe standup summary/.test(e.event.title));
  assert.ok(selfNote, 'Scribe 스탠드업 요약 note가 원장에 있어야 한다');
  assert.match(selfNote.event.detail, /notify_failures=0/);

  const md = await readFile(path.join(journalDir, `${T}.md`), 'utf8');
  assert.match(md, new RegExp(`# 개발일지 ${T}`));
  assert.match(md, /fac_demo/, 'Sentinel 통과가 실려야 한다');
  assert.match(md, /fac_bad:result:blank/, '실패 시그니처가 실려야 한다');
  assert.match(md, /nightcrew: 3 commits/, '커밋 digest가 실려야 한다');
  assert.match(md, /parse_failures=1/, '자기 파싱 실패 카운트가 R3로 노출되어야 한다');
  assert.match(md, /packs_run=2/, 'sentinel 요약 카운터가 노출되어야 한다');

  // 아침 1줄 스탠드업 (§6) — 파싱 실패 + 전 공급자의 스킵/쓰기 실패 합계 노출
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /\[Scribe\]/);
  assert.match(notifications[0], /parse=1/, '스탠드업에 R3 카운터 포함');
  assert.match(notifications[0], /skip_total=2/, 'sentinel(1)+수집기(1) 스킵 합계가 노출되어야 한다 (§6)');
});

test('멱등: 새 이벤트가 없으면 journal 내용이 변하지 않는다 (§2.4 커서)', async () => {
  const ledgerDir = await tmp();
  const storeDir = await tmp();
  const journalDir = await tmp();
  await seedLedger(ledgerDir);
  const { opts } = setup(ledgerDir, storeDir, journalDir);

  await runDaily(opts);
  const first = await readFile(path.join(journalDir, `${T}.md`), 'utf8');
  await runDaily(opts);
  const second = await readFile(path.join(journalDir, `${T}.md`), 'utf8');
  assert.equal(first, second, '중복 소비로 내용이 불어나면 안 된다');
});

test('증분: 나중에 추가된 이벤트가 journal에 반영된다', async () => {
  const ledgerDir = await tmp();
  const storeDir = await tmp();
  const journalDir = await tmp();
  await seedLedger(ledgerDir);
  const { opts } = setup(ledgerDir, storeDir, journalDir);

  await runDaily(opts);
  await appendFile(
    path.join(ledgerDir, `${T}.jsonl`),
    line({ ts: `${T}T09:00:00+09:00`, source: 'factory', app: 'fac_demo', kind: 'deploy', title: 'fac_demo 배포' })
  );
  await runDaily(opts);
  const md = await readFile(path.join(journalDir, `${T}.md`), 'utf8');
  assert.match(md, /fac_demo 배포/);
  assert.match(md, /parse_failures=1/, '재생성 후에도 그날의 파싱 실패가 보존되어야 한다 (R3)');
});

test('재작업 회귀: journal 쓰기 실패 후 재실행해도 이벤트가 중복되지 않는다', async () => {
  const { rm, writeFile: wf } = await import('node:fs/promises');
  const ledgerDir = await tmp();
  const storeDir = await tmp();
  const parent = await tmp();
  const journalDir = path.join(parent, 'journal');
  await seedLedger(ledgerDir);

  // journalDir 자리에 파일을 놓아 mkdir을 실패시킨다
  await wf(journalDir, 'blocker');
  const { opts } = setup(ledgerDir, storeDir, journalDir);
  const r1 = await runDaily(opts);
  assert.ok(r1.counters.journalWriteFailures >= 1);
  assert.equal(r1.daysWritten.length, 0);

  // 장애 해소 후 재실행 — 커서가 전진하지 않았으므로 재소비되지만 중복은 없어야 한다
  await rm(journalDir);
  const r2 = await runDaily(opts);
  assert.ok(r2.daysWritten.includes(T));
  const md = await readFile(path.join(journalDir, `${T}.md`), 'utf8');
  const passCount = (md.match(/fac_demo 통과/g) ?? []).length;
  assert.equal(passCount, 1, '재소비가 중복 기록이 되면 안 된다 (§2.4)');
});
