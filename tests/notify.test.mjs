import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { sendNotify } from '../notify/notify.mjs';

const CLI = new URL('../notify/notify.mjs', import.meta.url).pathname;

// 계기 격리: 자식 프로세스는 boot/env.mjs가 리포 루트 `.env`를 읽는다 — 운영자가 설정을 채우는
// 순간(LEDGER_DIR·SLACK_WEBHOOK_URL) '미설정' 테스트가 빨개지고, 알림 CLI 테스트는 **실제 Slack으로
// 발송**한다(실측 2026-09-04: .env를 만들자마자 스위트 1건이 상수로 빨개졌다). 존재하지 않는 파일을
// NC_ENV_FILE로 가리켜 자식이 아무 .env도 안 읽게 한다.
const NO_ENV_FILE = `${tmpdir()}/nightcrew-tests-no-env-file`;

function bareEnv() {
  const env = { ...process.env, NC_ENV_FILE: NO_ENV_FILE };
  for (const k of ['TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'SLACK_WEBHOOK_URL', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID']) delete env[k];
  return env;
}

test('§13 완성 기준: 채널 미설정 → 콘솔 폴백 + ok', async () => {
  const logs = [];
  const r = await sendNotify('테스트 알림', { env: {}, log: (m) => logs.push(m) });
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'console');
  assert.ok(logs.some((l) => l.includes('테스트 알림')));
});

test('Telegram 설정 시 sendMessage API를 호출한다', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const r = await sendNotify('hello', {
    env: { TELEGRAM_TOKEN: 'TTT', TELEGRAM_CHAT_ID: '123' },
    fetchImpl,
  });
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'telegram');
  assert.match(calls[0].url, /api\.telegram\.org\/botTTT\/sendMessage/);
  assert.equal(calls[0].body.chat_id, '123');
  assert.equal(calls[0].body.text, 'hello');
});

test('Slack 웹훅 설정 시 함께 발송한다 (보조 채널)', async () => {
  const urls = [];
  const fetchImpl = async (url, opts) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const r = await sendNotify('hi', {
    env: { TELEGRAM_TOKEN: 'T', TELEGRAM_CHAT_ID: '1', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x' },
    fetchImpl,
  });
  assert.equal(r.ok, true);
  assert.equal(urls.length, 2);
});

test('§11: photoPath가 있으면 Telegram sendPhoto(멀티파트)로 사진을 보낸다', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'nc-photo-'));
  const photo = path.join(dir, 'shot.png');
  await writeFile(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: opts.body });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const r = await sendNotify('실패 사진', {
    env: { TELEGRAM_TOKEN: 'T', TELEGRAM_CHAT_ID: '1' },
    fetchImpl,
    photoPath: photo,
  });
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /sendPhoto/);
  assert.ok(calls[0].body instanceof FormData, '사진은 멀티파트로 보내야 한다');
});

test('photoPath 파일이 없으면 텍스트만 발송하고 실패하지 않는다', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const r = await sendNotify('x', {
    env: { TELEGRAM_TOKEN: 'T', TELEGRAM_CHAT_ID: '1' },
    fetchImpl,
    photoPath: '/nonexistent/shot.png',
  });
  assert.equal(r.ok, true);
  assert.match(calls[0], /sendMessage/);
});

test('Slack 사진: SLACK_BOT_TOKEN+CHANNEL_ID가 있으면 files.uploadV2 3단계로 업로드한다', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'nc-slackphoto-'));
  const photo = path.join(dir, 'shot.png');
  await writeFile(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.includes('getUploadURLExternal')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, upload_url: 'https://files.slack.com/up/1', file_id: 'F1' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const r = await sendNotify('protected 실패', {
    env: { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x', SLACK_BOT_TOKEN: 'xb', SLACK_CHANNEL_ID: 'C123' },
    fetchImpl,
    photoPath: photo,
  });
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /getUploadURLExternal/);
  assert.equal(calls[1].url, 'https://files.slack.com/up/1');
  assert.match(calls[2].url, /completeUploadExternal/);
  const complete = JSON.parse(calls[2].opts.body);
  assert.equal(complete.channel_id, 'C123');
  assert.match(complete.initial_comment, /protected 실패/);
  assert.ok(!calls.some((c) => c.url.includes('hooks.slack.com')), '업로드 성공 시 웹훅 중복 발송 없음');
});

test('Slack 사진: 봇 토큰이 없으면 웹훅 텍스트로 폴백하고 경로를 남긴다', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: opts.body });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const r = await sendNotify('x', {
    env: { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x' },
    fetchImpl,
    photoPath: '/nonexistent/shot.png',
  });
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /hooks\.slack\.com/);
});

test('R3: 발송 실패해도 던지지 않고 ok:false를 반환한다', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const r = await sendNotify('x', { env: { TELEGRAM_TOKEN: 'T', TELEGRAM_CHAT_ID: '1' }, fetchImpl });
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test('CLI: 미설정 환경에서 exit 0 + 콘솔 출력', async () => {
  const { code, stdout } = await new Promise((resolve) => {
    execFile('node', [CLI, '수동 알림'], { env: bareEnv() }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })
    );
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes('수동 알림'));
});
