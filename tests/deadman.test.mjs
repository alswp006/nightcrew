import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDeadman } from '../watchdog/deadman.mjs';
import { todayKST } from '../collectors/lib/kst.mjs';

async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'nc-deadman-'));
}

const line = (o) => JSON.stringify(o) + '\n';
const T = todayKST();

function setup() {
  const notifications = [];
  const notifyImpl = async (text) => {
    notifications.push(text);
    return { ok: true };
  };
  return { notifications, notifyImpl };
}

test('오늘(KST) 파일에 heartbeat가 있으면 침묵한다 (v2.1 §8)', async () => {
  const dir = await tmp();
  await writeFile(
    path.join(dir, `${T}.jsonl`),
    line({ ts: `${T}T04:30:00+09:00`, source: 'sentinel', kind: 'heartbeat', title: 'start' })
  );
  const { notifications, notifyImpl } = setup();
  const r = await runDeadman({ backupLedgerDir: dir, markerPath: path.join(dir, 'marker.json'), notifyImpl });
  assert.equal(r.healthy, true);
  assert.equal(notifications.length, 0);
});

test('§13-2 완성 기준: 가짜 "빈 원장"이면 알림이 발화한다', async () => {
  const dir = await tmp(); // 오늘 파일 자체가 없음 = rsync 실패 또는 데스크톱 다운
  const { notifications, notifyImpl } = setup();
  const r = await runDeadman({ backupLedgerDir: dir, markerPath: path.join(dir, 'marker.json'), notifyImpl });
  assert.equal(r.healthy, false);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /\[Watchdog\]/);
});

test('파일은 있지만 heartbeat·run_*이 없으면 알림한다', async () => {
  const dir = await tmp();
  await writeFile(
    path.join(dir, `${T}.jsonl`),
    line({ ts: `${T}T01:00:00+09:00`, source: 'test', kind: 'note', title: 'noise' })
  );
  const { notifications, notifyImpl } = setup();
  const r = await runDeadman({ backupLedgerDir: dir, markerPath: path.join(dir, 'marker.json'), notifyImpl });
  assert.equal(r.healthy, false);
  assert.equal(notifications.length, 1);
});

test('자기 생존 마커: 실행 시마다 갱신, 오래 침묵했으면 경고를 덧붙인다', async () => {
  const dir = await tmp();
  await writeFile(
    path.join(dir, `${T}.jsonl`),
    line({ ts: `${T}T04:30:00+09:00`, source: 'sentinel', kind: 'run_pass', title: 'ok' })
  );
  const markerPath = path.join(dir, 'marker.json');
  // 마커가 30시간 전 — 감시견이 조용히 죽어 있었다
  await writeFile(markerPath, JSON.stringify({ lastRunAt: new Date(Date.now() - 30 * 3600 * 1000).toISOString() }));

  const { notifications, notifyImpl } = setup();
  const r = await runDeadman({ backupLedgerDir: dir, markerPath, notifyImpl });
  assert.equal(r.healthy, true);
  assert.equal(r.watchdogGapWarned, true);
  assert.equal(notifications.length, 1, '원장이 건강해도 감시견 공백은 알린다');
  assert.match(notifications[0], /감시견/);

  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.ok(marker.lastRunAt, '마커가 갱신되어야 한다');
  assert.ok(Date.now() - new Date(marker.lastRunAt).getTime() < 60_000);
});
