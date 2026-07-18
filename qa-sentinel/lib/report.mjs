// 결과 기록·판정 보조 — 원장과 artifacts에만 쓴다. 앱 코드에는 절대 쓰지 않는다(§12).
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

export async function writeResultJson(dir, result) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'result.json');
  await writeFile(file, JSON.stringify(result, null, 2) + '\n', 'utf8');
  return file;
}

// §11: protected의 claude -p 분석은 "2연속 실패 시" — 직전 run_*이 run_fail이면 이번 실패가 2연속.
export function isSecondConsecutiveFail(priorEvents, appId) {
  const runs = priorEvents.filter((e) => e.event.app === appId && /^run_/.test(e.event.kind));
  return runs.at(-1)?.event.kind === 'run_fail';
}

// claude CLI가 없거나 실패해도 본 실행은 계속된다 — 호출자가 스킵을 카운트한다(R3).
export function claudeReport({ appId, signatures, refs, bin = 'claude', timeoutMs = 120_000 }) {
  const prompt =
    `Sentinel 새벽 QA에서 protected 앱 "${appId}"이 2연속 실패했다.\n` +
    `error_signature: ${signatures.join(', ')}\n증거 파일: ${refs.join(', ')}\n` +
    `증거를 읽고 원인 가설과 사람이 확인할 체크리스트를 한국어로 간결히 보고하라. 앱 코드는 수정하지 마라.`;
  return new Promise((resolve) => {
    // 증거(스크린샷·콘솔 텍스트)는 원격 유래 콘텐츠다 — 프롬프트 주입에 대비해 읽기 도구만 허용한다
    execFile(bin, ['--allowedTools', 'Read', '-p', prompt], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) resolve({ ok: false, reason: err.message });
      else resolve({ ok: true, report: stdout.trim() });
    });
  });
}
