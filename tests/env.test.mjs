import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadDotEnv, banner } from '../boot/env.mjs';
import { expandHome } from '../collectors/lib/paths.mjs';

async function tmpEnvFile(content) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nc-env-'));
  const file = path.join(dir, '.env');
  await writeFile(file, content);
  return file;
}

test('loadDotEnv: KEY=VALUE 파싱, 이미 설정된 env는 덮지 않는다', async () => {
  const file = await tmpEnvFile('A=1\nB=2\n# comment\n');
  const env = { B: 'existing' };
  loadDotEnv(file, env);
  assert.equal(env.A, '1');
  assert.equal(env.B, 'existing');
});

test('loadDotEnv: 값의 후행 공백·탭을 제거하고 따옴표를 벗긴다', async () => {
  const file = await tmpEnvFile('P="/some/dir" \nQ=/other/dir\t\n');
  const env = {};
  loadDotEnv(file, env);
  assert.equal(env.P, '/some/dir');
  assert.equal(env.Q, '/other/dir');
});

test('expandHome: 선두 ~/ 를 홈으로 확장한다 (§14 기본값 "~/nightcrew/ledger" 지원)', () => {
  assert.equal(expandHome('~/nightcrew/ledger', '/home/me'), '/home/me/nightcrew/ledger');
  assert.equal(expandHome('/abs/path', '/home/me'), '/abs/path');
  assert.equal(expandHome(undefined, '/home/me'), undefined);
});

test('banner: 해석된 LEDGER_DIR 절대경로(~ 확장 포함)·채널·KST 날짜를 1줄로 밝힌다 (R2)', () => {
  const lines = [];
  const line = banner('testcomp', {
    env: { LEDGER_DIR: '~/nc-ledger', TELEGRAM_TOKEN: 't', TELEGRAM_CHAT_ID: '1' },
    log: (m) => lines.push(m),
  });
  assert.equal(lines.length, 1);
  assert.match(line, /component=testcomp/);
  assert.match(line, /LEDGER_DIR=\/.*nc-ledger/, '~가 절대경로로 확장되어 보여야 한다');
  assert.match(line, /notify=telegram/);
  assert.match(line, /todayKST=\d{4}-\d{2}-\d{2}/);
});
