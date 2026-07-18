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

const line = (o) => JSON.stringify(o) + '\n';
const ev = (title, kind = 'note') => ({ ts: '2026-07-18T03:00:00+09:00', source: 'test', kind, title });

function runCli(args, env) {
  return new Promise((resolve) => {
    execFile('node', [CLI, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) =>
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
