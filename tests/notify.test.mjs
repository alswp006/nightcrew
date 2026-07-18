import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { sendNotify } from '../notify/notify.mjs';

const CLI = new URL('../notify/notify.mjs', import.meta.url).pathname;

function bareEnv() {
  const env = { ...process.env };
  for (const k of ['TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'SLACK_WEBHOOK_URL']) delete env[k];
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
