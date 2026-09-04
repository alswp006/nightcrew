import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const CLI = new URL('../collectors/ledger-read.mjs', import.meta.url).pathname;

async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'nc-readcli-'));
}

// 계기 격리: 자식 프로세스는 boot/env.mjs가 리포 루트 `.env`를 읽는다 — 운영자가 설정을 채우는
// 순간(LEDGER_DIR·SLACK_WEBHOOK_URL) '미설정' 테스트가 빨개지고, 알림 CLI 테스트는 **실제 Slack으로
// 발송**한다(실측 2026-09-04: .env를 만들자마자 스위트 1건이 상수로 빨개졌다). 존재하지 않는 파일을
// NC_ENV_FILE로 가리켜 자식이 아무 .env도 안 읽게 한다.
const NO_ENV_FILE = path.join(tmpdir(), 'nightcrew-tests-no-env-file');

const line = (o) => JSON.stringify(o) + '\n';
const ev = (title, kind = 'note') => ({ ts: '2026-07-18T03:00:00+09:00', source: 'test', kind, title });

function runCli(args, env) {
  return new Promise((resolve) => {
    execFile('node', [CLI, ...args], { env: { ...process.env, NC_ENV_FILE: NO_ENV_FILE, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })
    );
  });
}

test('CLI: 소비자 커서로 읽고(--consumer) 저장(--save-cursor)하는 왕복 — ai-factory §7.3 소비용', async () => {
  const ledgerDir = await tmp();
  const storeDir = await tmp();
  await writeFile(
    path.join(ledgerDir, '2026-07-18.jsonl'),
    line(ev('a')) + line(ev('힐 요청', 'heal_request'))
  );
  const env = { LEDGER_DIR: ledgerDir };

  const first = await runCli([`--consumer=self-heal`, `--store-dir=${storeDir}`], env);
  assert.equal(first.code, 0);
  const data = JSON.parse(first.stdout); // stdout은 JSON 전용 — 배너는 stderr
  assert.equal(data.events.length, 2);
  assert.match(first.stderr, /component=ledger-read/, 'R2 배너는 stderr로');

  const save = await runCli(
    [`--consumer=self-heal`, `--store-dir=${storeDir}`, `--save-cursor=${JSON.stringify(data.cursor)}`],
    env
  );
  assert.equal(save.code, 0);

  await appendFile(path.join(ledgerDir, '2026-07-18.jsonl'), line(ev('new', 'heal_request')));
  const second = await runCli([`--consumer=self-heal`, `--store-dir=${storeDir}`], env);
  const data2 = JSON.parse(second.stdout);
  assert.deepEqual(data2.events.map((e) => e.event.title), ['new'], '커서 이후 이벤트만');
});

test('CLI: --consumer 없이는 exit 2', async () => {
  const r = await runCli([], { LEDGER_DIR: '/nonexistent' });
  assert.equal(r.code, 2);
});
