// 개발일지 요약 — 민감도 등급(§6)상 개발일지는 어느 엔진이든 가능.
// auto: claude CLI → 로컬 Ollama → 템플릿 폴백. 실패는 조용히 폴백하고 호출자가 사용 엔진을 로그한다.
import { execFile } from 'node:child_process';

export function templateSummary(dayEvents) {
  const runs = dayEvents.filter((e) => /^run_/.test(e.kind));
  const pass = runs.filter((e) => e.kind === 'run_pass').length;
  const flaky = runs.filter((e) => e.kind === 'run_flaky').length;
  const fail = runs.filter((e) => e.kind === 'run_fail').length;
  const commits = dayEvents.filter((e) => e.kind === 'commit_digest').length;
  const deploys = dayEvents.filter((e) => e.kind === 'deploy').length;
  const heals = dayEvents.filter((e) => /^heal_/.test(e.kind)).length;

  const parts = [];
  if (runs.length) parts.push(`Sentinel ${runs.length}팩 (통과 ${pass}·flaky ${flaky}·실패 ${fail})`);
  if (commits) parts.push(`커밋 digest ${commits}건`);
  if (deploys) parts.push(`배포 ${deploys}건`);
  if (heals) parts.push(`heal 이벤트 ${heals}건`);
  return parts.join(' · ') || '기록된 활동 없음';
}

function tryClaude(prompt, { bin, timeoutMs = 60_000 }) {
  return new Promise((resolve) => {
    execFile(bin, ['-p', prompt], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

async function tryOllama(prompt, { url, model, timeoutMs = 60_000 }) {
  try {
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.response ?? '').trim() || null;
  } catch {
    return null;
  }
}

// §6 민감도 등급: 세션 로그 계열은 원문 외부 전송 금지 — LLM 프롬프트에서 통째로 제외한다
// (개발일지 자체는 어느 엔진이든 가능하지만, 프롬프트에 실리는 이벤트는 선별한다).
const SENSITIVE_KINDS = new Set(['session_digest']);

export async function summarize(dayEvents, { engine = 'auto', env = process.env, log = () => {} } = {}) {
  const base = templateSummary(dayEvents);
  if (engine === 'template') return base;

  const shareable = dayEvents.filter((e) => !SENSITIVE_KINDS.has(e.kind));
  const titles = shareable.map((e) => `- [${e.source}] ${e.kind}: ${e.title}${e.detail ? ` (${e.detail.slice(0, 120)})` : ''}`);
  const prompt =
    `아래는 개인 프로젝트의 하루치 이벤트 원장이다. 개발일지 요약을 한국어 3~4문장으로 써라. ` +
    `과장 없이 사실만, 실패가 있으면 반드시 언급.\n${titles.slice(0, 80).join('\n')}`;

  const viaClaude = await tryClaude(prompt, { bin: env.NC_CLAUDE_BIN ?? 'claude' });
  if (viaClaude) {
    log('claude');
    return viaClaude;
  }
  if (env.OLLAMA_URL) {
    const viaOllama = await tryOllama(prompt, { url: env.OLLAMA_URL, model: env.NC_OLLAMA_MODEL ?? 'llama3' });
    if (viaOllama) {
      log('ollama');
      return viaOllama;
    }
  }
  log('template');
  return base;
}
