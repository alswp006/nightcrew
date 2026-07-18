// §10 계약 D: 공용 notify 유틸. 무상태 단건 발송 — 배칭은 "실행 종료" 시점을 아는 호출자(Sentinel 엔진)가 한다.
// 채널: TELEGRAM_TOKEN+TELEGRAM_CHAT_ID(기본) 그리고/또는 SLACK_WEBHOOK_URL(보조). 미설정 → 콘솔 폴백.
// photoPath가 있으면 Telegram은 sendPhoto(사진+캡션)로 보낸다(§11 protected "사진+보고서").
// 실패해도 절대 던지지 않는다 — 본 작업은 계속되고 호출자가 실패를 카운트한다(R3).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TELEGRAM_CAPTION_LIMIT = 1000;

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
