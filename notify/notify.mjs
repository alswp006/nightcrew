// §10 계약 D: 공용 notify 유틸. 무상태 단건 발송 — 배칭은 "실행 종료" 시점을 아는 호출자(Sentinel 엔진)가 한다.
// 채널(v2.2 — 사용자 결정): SLACK_WEBHOOK_URL(기본) 그리고/또는 TELEGRAM_TOKEN+TELEGRAM_CHAT_ID(옵션). 미설정 → 콘솔 폴백.
// photoPath(§11 protected "사진+보고서"): Slack은 SLACK_BOT_TOKEN+SLACK_CHANNEL_ID가 있으면
// files.uploadV2(3단계)로 업로드하고, 없으면 웹훅 텍스트에 경로만 남긴다. Telegram은 sendPhoto.
// 실패해도 절대 던지지 않는다 — 본 작업은 계속되고 호출자가 실패를 카운트한다(R3).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TELEGRAM_CAPTION_LIMIT = 1000;

// Slack 웹훅은 파일을 못 싣는다 — 사진은 봇 토큰의 files.uploadV2 흐름으로만 가능:
// ① getUploadURLExternal → ② 그 URL로 바이트 POST → ③ completeUploadExternal(채널+코멘트)
async function slackUploadPhoto({ env, fetchImpl, photoBuf, filename, text }) {
  const auth = { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` };
  const r1 = await fetchImpl(
    `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${photoBuf.length}`,
    { method: 'GET', headers: auth }
  );
  const j1 = await r1.json();
  if (!j1.ok) throw new Error(`getUploadURLExternal: ${j1.error ?? r1.status}`);
  const r2 = await fetchImpl(j1.upload_url, { method: 'POST', body: photoBuf });
  if (!r2.ok) throw new Error(`upload: HTTP ${r2.status}`);
  const r3 = await fetchImpl('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      files: [{ id: j1.file_id, title: filename }],
      channel_id: env.SLACK_CHANNEL_ID,
      initial_comment: text,
    }),
  });
  const j3 = await r3.json();
  if (!j3.ok) throw new Error(`completeUploadExternal: ${j3.error ?? r3.status}`);
}

export async function sendNotify(text, { env = process.env, fetchImpl = fetch, log = console.log, photoPath } = {}) {
  const channels = [];
  if (env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT_ID) channels.push('telegram');
  if (env.SLACK_WEBHOOK_URL) channels.push('slack');

  if (channels.length === 0) {
    log(`[notify-fallback] ${text}${photoPath ? ` (photo: ${photoPath})` : ''}`);
    return { ok: true, channel: 'console' };
  }

  let photoBuf = null;
  if (photoPath) {
    try {
      photoBuf = await readFile(photoPath);
    } catch {
      // 사진을 못 읽으면 텍스트만 발송 — 알림 자체를 막지 않는다
    }
  }

  const failures = [];
  for (const channel of channels) {
    try {
      let res;
      if (channel === 'telegram' && photoBuf) {
        const form = new FormData();
        form.append('chat_id', env.TELEGRAM_CHAT_ID);
        form.append('caption', text.slice(0, TELEGRAM_CAPTION_LIMIT));
        form.append('photo', new Blob([photoBuf], { type: 'image/png' }), path.basename(photoPath));
        res = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPhoto`, {
          method: 'POST',
          body: form,
        });
      } else if (channel === 'telegram') {
        res = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
        });
      } else if (photoBuf && env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID) {
        await slackUploadPhoto({ env, fetchImpl, photoBuf, filename: path.basename(photoPath), text });
        res = { ok: true, status: 200 };
      } else {
        res = await fetchImpl(env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: photoPath ? `${text}\n(사진: ${photoPath})` : text }),
        });
      }
      if (!res.ok) failures.push(`${channel}: HTTP ${res.status}`);
    } catch (err) {
      failures.push(`${channel}: ${err.message}`);
    }
  }

  if (failures.length === channels.length) {
    return { ok: false, reason: failures.join('; ') };
  }
  return { ok: true, channel: channels.join('+'), partialFailures: failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadDotEnv, banner } = await import('../boot/env.mjs');
  loadDotEnv();
  banner('notify');
  const text = process.argv.slice(2).join(' ') || '(empty notify)';
  const r = await sendNotify(text);
  if (!r.ok) console.error(`[notify] send failed: ${r.reason}`);
  // 실패는 exit 1로 알린다 — 호출자가 실패를 카운트할 수 있게(R3). 발송 실패로 본 작업을
  // 중단할지 여부는 호출자 몫이다(셸에서는 `|| true`로 무시 가능).
  process.exit(r.ok ? 0 : 1);
}
