import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCareer } from '../scribe/career.mjs';
import { todayKST } from '../collectors/lib/kst.mjs';

async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'nc-career-'));
}

const T = todayKST();
const line = (o) => JSON.stringify(o) + '\n';

async function seedLedger(dir) {
  const events = [
    { ts: `${T}T02:10:00+09:00`, source: 'factory', app: 'fac_demo', kind: 'deploy', title: 'fac_demo 배포' },
    { ts: `${T}T03:00:00+09:00`, source: 'factory', app: 'fac_demo', kind: 'heal_done', title: 'fac_demo 자가 수리 완료' },
    { ts: `${T}T04:30:00+09:00`, source: 'sentinel', kind: 'heartbeat', title: 'start' }, // 후보 아님
  ];
  await writeFile(path.join(dir, `${T}.jsonl`), events.map(line).join(''));
}

function setup(ledgerDir, careerDir, cursorDir) {
  const notifications = [];
  return {
    opts: {
      ledgerDir,
      careerDir,
      cursorDir,
      notifyImpl: async (text) => {
        notifications.push(text);
        return { ok: true };
      },
    },
    notifications,
  };
}

test('성과성 이벤트(deploy·heal_done)가 경력 후보로 적립되고 확인 요청 알림 1건', async () => {
  const ledgerDir = await tmp();
  const careerDir = await tmp();
  const cursorDir = await tmp();
  await seedLedger(ledgerDir);
  const { opts, notifications } = setup(ledgerDir, careerDir, cursorDir);

  const r = await runCareer(opts);
  assert.equal(r.newCandidates, 2);

  const pending = await readFile(path.join(careerDir, 'pending.md'), 'utf8');
  assert.match(pending, /fac_demo 배포/);
  assert.match(pending, /자가 수리 완료/);
  assert.match(pending, /- \[ \]/, '미확인 체크박스 형식이어야 한다');
  assert.equal(notifications.length, 1, '§6: 사람 입력 지점은 확인 답장 하나 — 요청 알림 1건');
  assert.match(notifications[0], /경력 후보 2건/);
});

test('멱등: 재실행 시 같은 후보를 다시 만들지 않는다 (§2.4 커서)', async () => {
  const ledgerDir = await tmp();
  const careerDir = await tmp();
  const cursorDir = await tmp();
  await seedLedger(ledgerDir);
  const { opts, notifications } = setup(ledgerDir, careerDir, cursorDir);

  await runCareer(opts);
  const r2 = await runCareer(opts);
  assert.equal(r2.newCandidates, 0);
  const pending = await readFile(path.join(careerDir, 'pending.md'), 'utf8');
  assert.equal((pending.match(/fac_demo 배포/g) ?? []).length, 1);
  assert.equal(notifications.length, 1, '새 후보가 없으면 확인 요청을 반복하지 않는다');
});

test('확인 답장 [x] → 경력 원장 승격, [s] → 폐기', async () => {
  const ledgerDir = await tmp();
  const careerDir = await tmp();
  const cursorDir = await tmp();
  await seedLedger(ledgerDir);
  const { opts } = setup(ledgerDir, careerDir, cursorDir);

  await runCareer(opts);
  let pending = await readFile(path.join(careerDir, 'pending.md'), 'utf8');
  pending = pending.replace('- [ ]', '- [x]'); // 첫 후보(배포) 확정
  pending = pending.replace('- [ ]', '- [s]'); // 둘째 후보(수리) 폐기
  await writeFile(path.join(careerDir, 'pending.md'), pending);

  const r = await runCareer(opts);
  assert.equal(r.promoted, 1);
  assert.equal(r.discarded, 1);

  const ledger = await readFile(path.join(careerDir, 'ledger.md'), 'utf8');
  assert.match(ledger, /fac_demo 배포/);
  assert.ok(!ledger.includes('자가 수리 완료'), '폐기된 후보는 원장에 없어야 한다');

  const after = await readFile(path.join(careerDir, 'pending.md'), 'utf8');
  assert.ok(!after.includes('fac_demo 배포'), '처리된 후보는 pending에서 제거');
  assert.ok(!after.includes('자가 수리 완료'));
});

test('재작업 회귀: 대문자 [X]도 승격, 형식 어긋난 줄은 보존, 재실행에도 이중 승격 없음', async () => {
  const ledgerDir = await tmp();
  const careerDir = await tmp();
  const cursorDir = await tmp();
  await seedLedger(ledgerDir);
  const { opts } = setup(ledgerDir, careerDir, cursorDir);

  await runCareer(opts);
  let pending = await readFile(path.join(careerDir, 'pending.md'), 'utf8');
  pending = pending.replace('- [ ]', '- [X]'); // 사람은 대문자를 쓸 수 있다
  pending += '이건 형식이 어긋난 메모 줄\n';
  await writeFile(path.join(careerDir, 'pending.md'), pending);

  const r = await runCareer(opts);
  assert.equal(r.promoted, 1, '[X]도 승격되어야 한다');
  assert.equal(r.malformedLines, 1);
  const after = await readFile(path.join(careerDir, 'pending.md'), 'utf8');
  assert.match(after, /형식이 어긋난 메모 줄/, '사람이 쓴 줄을 조용히 지우면 안 된다 (R3)');

  // 승격된 항목을 (파일 병합 사고 등으로) 다시 [x]로 넣어도 원장에 중복되지 않는다
  const ledger1 = await readFile(path.join(careerDir, 'ledger.md'), 'utf8');
  const promotedLine = ledger1.trim().split('\n').at(-1);
  const id = /<!-- (\S+) -->/.exec(promotedLine)[1];
  await writeFile(
    path.join(careerDir, 'pending.md'),
    after + `- [x] ${id} | 2026-07-18 | fac_demo 배포\n`
  );
  await runCareer(opts);
  const ledger2 = await readFile(path.join(careerDir, 'ledger.md'), 'utf8');
  assert.equal((ledger2.match(/fac_demo 배포/g) ?? []).length, 1, '같은 id는 두 번 승격되지 않는다');
});

test('후보성 이벤트가 없으면 파일도 알림도 만들지 않는다', async () => {
  const ledgerDir = await tmp();
  const careerDir = await tmp();
  const cursorDir = await tmp();
  await writeFile(
    path.join(ledgerDir, `${T}.jsonl`),
    line({ ts: `${T}T04:30:00+09:00`, source: 'sentinel', kind: 'heartbeat', title: 'start' })
  );
  const { opts, notifications } = setup(ledgerDir, careerDir, cursorDir);

  const r = await runCareer(opts);
  assert.equal(r.newCandidates, 0);
  assert.equal(notifications.length, 0);
  assert.ok(!existsSync(path.join(careerDir, 'pending.md')));
});
