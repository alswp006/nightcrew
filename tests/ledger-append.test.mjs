import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendEvent } from '../collectors/ledger-append.mjs';
import { todayKST } from '../collectors/lib/kst.mjs';

const run = promisify(execFile);
const CLI = new URL('../collectors/ledger-append.mjs', import.meta.url).pathname;

const okEvent = () => ({
  ts: '2026-07-18T03:12:44+09:00',
  source: 'test',
  kind: 'note',
  title: 'hi',
});

async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'nc-ledger-'));
}

// 계기 격리: 자식 프로세스는 boot/env.mjs가 리포 루트 `.env`를 읽는다 — 운영자가 설정을 채우는
// 순간(LEDGER_DIR·SLACK_WEBHOOK_URL) '미설정' 테스트가 빨개지고, 알림 CLI 테스트는 **실제 Slack으로
// 발송**한다(실측 2026-09-04: .env를 만들자마자 스위트 1건이 상수로 빨개졌다). 존재하지 않는 파일을
// NC_ENV_FILE로 가리켜 자식이 아무 .env도 안 읽게 한다.
const NO_ENV_FILE = path.join(tmpdir(), 'nightcrew-tests-no-env-file');

function cliEnv(ledgerDir) {
  const env = { ...process.env, NC_ENV_FILE: NO_ENV_FILE };
  delete env.LEDGER_DIR;
  if (ledgerDir) env.LEDGER_DIR = ledgerDir;
  return env;
}

function pipeCli(input, env) {
  return new Promise((resolve) => {
    const child = execFile('node', [CLI], { env }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

test('§13 완성 기준: echo JSON | ledger-append → 오늘(KST) 파일에 정확히 1줄', async () => {
  const dir = await tmp();
  const r = await pipeCli(JSON.stringify(okEvent()), cliEnv(dir));
  assert.equal(r.code, 0);
  const file = path.join(dir, `${todayKST()}.jsonl`);
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), okEvent());
});

test('§13 완성 기준: LEDGER_DIR 언셋 → 경고 1줄 + exit 0, 파일 없음', async () => {
  const r = await pipeCli(JSON.stringify(okEvent()), cliEnv(null));
  assert.equal(r.code, 0);
  assert.ok(r.stderr.trim().length > 0, '경고가 stderr에 있어야 한다');
});

test('시크릿이 detail에 있으면 거부 — 원장 미기록, exit 2', async () => {
  const dir = await tmp();
  const bad = { ...okEvent(), detail: 'token ghp_16C7e42F292c6912E7710c838347Ae178B4a' };
  const r = await pipeCli(JSON.stringify(bad), cliEnv(dir));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /secret/i);
  assert.ok(!existsSync(path.join(dir, `${todayKST()}.jsonl`)), '거부된 이벤트는 기록되지 않아야 한다');
});

test('§12: 시크릿 스캔은 title·detail만이 아니라 이벤트 전체(추가 필드·refs 포함)를 본다', async () => {
  const dir = await tmp();
  const viaExtraField = await appendEvent(
    { ...okEvent(), debug: 'token ghp_16C7e42F292c6912E7710c838347Ae178B4a' },
    { ledgerDir: dir }
  );
  assert.equal(viaExtraField.ok, false);
  assert.equal(viaExtraField.rejected, true, '임의 추가 필드로 스캔을 우회할 수 없어야 한다');

  // 가짜 웹훅이지만 push protection 오인 방지를 위해 소스에서는 분리 조립
  const fakeWebhook = ['https://hooks.slack.com/', 'services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX'].join('');
  const viaRefs = await appendEvent({ ...okEvent(), refs: [fakeWebhook] }, { ledgerDir: dir });
  assert.equal(viaRefs.rejected, true, 'refs URL의 시크릿도 거부되어야 한다');
});

test('module API: 필수 필드 누락은 rejected로 거부한다', async () => {
  const dir = await tmp();
  const r = await appendEvent({ source: 'test', kind: 'note' }, { ledgerDir: dir });
  assert.equal(r.ok, false);
  assert.equal(r.rejected, true);
  assert.match(r.reason, /ts/);
});

test('module API: LEDGER_DIR 미설정은 skipped — 예외를 던지지 않는다', async () => {
  const r = await appendEvent(okEvent(), { ledgerDir: undefined });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
});

test('동시 쓰기 안전: 병렬 20건 append → 전부 온전한 JSON 20줄', async () => {
  const dir = await tmp();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      appendEvent({ ...okEvent(), title: `event-${i}`, detail: 'x'.repeat(500) }, { ledgerDir: dir })
    )
  );
  const file = path.join(dir, `${todayKST()}.jsonl`);
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 20);
  for (const line of lines) JSON.parse(line); // 찢긴 줄이 있으면 throw
});

test('R1: 셸 env 없이 .env 파일만으로 CLI가 원장을 쓴다', async () => {
  const dir = await tmp();
  const envFile = path.join(await tmp(), '.env');
  await (await import('node:fs/promises')).writeFile(envFile, `LEDGER_DIR=${dir}\n`);
  const env = cliEnv(null);
  env.NC_ENV_FILE = envFile;
  const r = await pipeCli(JSON.stringify(okEvent()), env);
  assert.equal(r.code, 0);
  const lines = (await readFile(path.join(dir, `${todayKST()}.jsonl`), 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 1, '.env의 LEDGER_DIR이 로드되어야 한다 (R1)');
});

test('실제 병렬 프로세스 20개의 CLI append → 전부 온전한 20줄', async () => {
  const dir = await tmp();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      pipeCli(JSON.stringify({ ...okEvent(), title: `proc-${i}`, detail: 'y'.repeat(300) }), cliEnv(dir))
    )
  );
  const lines = (await readFile(path.join(dir, `${todayKST()}.jsonl`), 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 20);
  for (const l of lines) JSON.parse(l);
});

test('stale 락(6초 전)은 회수하고 정상 append한다', async () => {
  const dir = await tmp();
  const { writeFile: wf, utimes } = await import('node:fs/promises');
  const file = path.join(dir, `${todayKST()}.jsonl`);
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
  await wf(`${file}.lock`, '');
  const old = new Date(Date.now() - 6000);
  await utimes(`${file}.lock`, old, old);
  const r = await appendEvent(okEvent(), { ledgerDir: dir });
  assert.equal(r.ok, true, 'stale 락은 회수되어야 한다');
});

test('신선한 락이 잡혀 있으면 타임아웃 시 throw 없이 ok:false', async () => {
  const dir = await tmp();
  const { writeFile: wf, mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${todayKST()}.jsonl`);
  await wf(`${file}.lock`, '');
  const r = await appendEvent(okEvent(), { ledgerDir: dir, lockTimeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /lock/i);
});

test('KST 날짜 경계: UTC 전날 밤이라도 KST 오늘 파일에 쓴다', async () => {
  const dir = await tmp();
  // 2026-07-17T19:30Z = 2026-07-18T04:30+09:00 (Sentinel 실행 시각)
  const r = await appendEvent(okEvent(), { ledgerDir: dir, now: new Date('2026-07-17T19:30:00Z') });
  assert.equal(r.ok, true);
  const files = await readdir(dir);
  assert.deepEqual(files, ['2026-07-18.jsonl']);
});
