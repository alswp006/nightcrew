import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readEvents, loadCursor, saveCursor } from '../collectors/ledger-read.mjs';
import { todayKST } from '../collectors/lib/kst.mjs';

async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'nc-read-'));
}

const line = (o) => JSON.stringify(o) + '\n';
const ev = (title) => ({ ts: '2026-07-18T03:00:00+09:00', source: 'test', kind: 'note', title });

test('R3: 파싱 실패 줄은 건너뛰되 개수를 센다', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, '2026-07-18.jsonl'), line(ev('a')) + 'NOT JSON\n' + line(ev('b')));
  const r = await readEvents({ ledgerDir: dir });
  assert.equal(r.events.length, 2);
  assert.equal(r.parseFailures, 1);
  assert.deepEqual(r.events.map((e) => e.event.title), ['a', 'b']);
});

test('원장 디렉터리가 없으면 빈 결과 — 예외를 던지지 않는다 (원칙 2)', async () => {
  const r = await readEvents({ ledgerDir: '/nonexistent/nc-ledger' });
  assert.deepEqual(r.events, []);
  assert.equal(r.parseFailures, 0);
});

test('§2.4 커서 멱등 소비: 재실행 시 중복 0건, 새 이벤트만 반환', async () => {
  const dir = await tmp();
  const store = await tmp();
  const f = path.join(dir, '2026-07-18.jsonl');
  await writeFile(f, line(ev('a')) + line(ev('b')));

  const first = await readEvents({ ledgerDir: dir, cursor: await loadCursor('scribe', { storeDir: store }) });
  assert.equal(first.events.length, 2);
  await saveCursor('scribe', first.cursor, { storeDir: store });

  const again = await readEvents({ ledgerDir: dir, cursor: await loadCursor('scribe', { storeDir: store }) });
  assert.equal(again.events.length, 0, '같은 이벤트를 두 번 처리하면 안 된다');

  await appendFile(f, line(ev('c')));
  const third = await readEvents({ ledgerDir: dir, cursor: await loadCursor('scribe', { storeDir: store }) });
  assert.deepEqual(third.events.map((e) => e.event.title), ['c']);
});

test('R3: 파일 읽기 실패는 readFailures로 세고 커서는 그 파일을 지나치지 않는다', async () => {
  const { chmod } = await import('node:fs/promises');
  const dir = await tmp();
  const blocked = path.join(dir, '2026-07-17.jsonl');
  await writeFile(blocked, line(ev('hidden')));
  await writeFile(path.join(dir, '2026-07-18.jsonl'), line(ev('later')));
  await chmod(blocked, 0o000);

  const r = await readEvents({ ledgerDir: dir });
  assert.equal(r.readFailures, 1, '읽기 실패는 카운트되어야 한다 (R3)');
  assert.ok(!r.cursor || r.cursor.file < '2026-07-17.jsonl', '커서가 실패 파일을 지나쳐 전진하면 안 된다');

  await chmod(blocked, 0o644);
  const again = await readEvents({ ledgerDir: dir, cursor: r.cursor });
  assert.deepEqual(
    again.events.map((e) => e.event.title),
    ['hidden', 'later'],
    '복구 후 유실 없이 소비되어야 한다 (§2.4 멱등)'
  );
});

test('오늘 파일의 개행 없는 미완성 마지막 줄은 소비하지 않고 커서에도 넣지 않는다', async () => {
  const dir = await tmp();
  const f = path.join(dir, `${todayKST()}.jsonl`); // "쓰는 중" 판정은 오늘 파일에만 적용된다
  await writeFile(f, line(ev('done')) + '{"ts":"2026-07-18T03:00:00+09:0'); // 쓰기 도중 상태

  const first = await readEvents({ ledgerDir: dir });
  assert.deepEqual(first.events.map((e) => e.event.title), ['done']);
  assert.equal(first.parseFailures, 0, '오늘 파일의 미완성 줄은 파싱 실패가 아니다');
  assert.equal(first.cursor.line, 1);

  await appendFile(f, '0","source":"test","kind":"note","title":"finished"}\n');
  const next = await readEvents({ ledgerDir: dir, cursor: first.cursor });
  assert.deepEqual(next.events.map((e) => e.event.title), ['finished'], '완성된 뒤에는 소비되어야 한다');
});

test('과거 파일의 개행 없는 꼬리는 크래시 잔재 — 세고 지나가서 소비자를 영구 정지시키지 않는다', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, '2026-01-01.jsonl'), line(ev('old')) + '{"partial'); // 과거 크래시 잔재
  await writeFile(path.join(dir, '2026-01-02.jsonl'), line(ev('next-day')));

  const r = await readEvents({ ledgerDir: dir });
  assert.deepEqual(r.events.map((e) => e.event.title), ['old', 'next-day'], '뒤 파일까지 전진해야 한다');
  assert.equal(r.parseFailures, 1, '버려진 꼬리는 반드시 센다 (R3)');
  assert.equal(r.cursor.file, '2026-01-02.jsonl', '커서가 잔재 파일에 고착되면 모든 소비자가 무음 정지한다');
});

test('손상된 커서 파일은 null로 처리하고 던지지 않는다', async () => {
  const { writeFile: wf, mkdir } = await import('node:fs/promises');
  const store = await tmp();
  await mkdir(store, { recursive: true });
  await wf(path.join(store, 'broken.json'), 'NOT JSON');
  const c = await loadCursor('broken', { storeDir: store });
  assert.equal(c, null);
});

test('커서는 여러 날짜 파일을 순서대로 가로지른다', async () => {
  const dir = await tmp();
  const store = await tmp();
  await writeFile(path.join(dir, '2026-07-17.jsonl'), line(ev('old')));
  await writeFile(path.join(dir, '2026-07-18.jsonl'), line(ev('new')));

  const first = await readEvents({ ledgerDir: dir });
  assert.deepEqual(first.events.map((e) => e.event.title), ['old', 'new']);
  await saveCursor('c2', first.cursor, { storeDir: store });

  await writeFile(path.join(dir, '2026-07-19.jsonl'), line(ev('newest')));
  const next = await readEvents({ ledgerDir: dir, cursor: await loadCursor('c2', { storeDir: store }) });
  assert.deepEqual(next.events.map((e) => e.event.title), ['newest']);
});
