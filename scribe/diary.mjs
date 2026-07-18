// §6 세 줄 일기 작가 (Scribe Phase 3). 민감도 등급: **로컬 엔진(데스크톱 Ollama) 전용** —
// 로컬 엔진이 없으면 대기하고, 어떤 외부 엔진 폴백도 하지 않는다(원문 외부 전송 금지).
// 사진 메타(Immich)는 준비 시 이벤트 소스로 추가 — 자리만 예약.
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readEvents } from '../collectors/ledger-read.mjs';
import { appendEvent } from '../collectors/ledger-append.mjs';
import { todayKST, nowISOKST } from '../collectors/lib/kst.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function localOllamaUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return LOCAL_HOSTS.has(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

export async function runDiary({
  ledgerDir = process.env.LEDGER_DIR,
  diaryDir = path.join(REPO_ROOT, 'journal', 'diary'),
  day,
  env = process.env,
  now = new Date(),
  log = console.log,
} = {}) {
  day = day ?? todayKST(now);
  // R3: 대기·실패도 원장 note로 남겨 다이제스트에 도달시킨다
  const summaryNote = (detail) =>
    appendEvent(
      { ts: nowISOKST(now), source: 'scribe', kind: 'note', title: 'diary run summary', detail },
      { ledgerDir }
    );

  const ollama = localOllamaUrl(env.OLLAMA_URL);
  if (!ollama) {
    const reason = env.OLLAMA_URL
      ? `OLLAMA_URL(${env.OLLAMA_URL})이 로컬호스트가 아니다 — 일기 원문은 외부 전송 금지(§6)`
      : '로컬 Ollama 미설정 — 일기 작가는 대기(§6)';
    log(`[diary] waiting: ${reason}`);
    await summaryNote('status=waiting reason=no-local-engine');
    return { waiting: true, reason };
  }

  const r = await readEvents({ ledgerDir });
  const dayEvents = r.events.filter((item) => item.file === `${day}.jsonl`).map((item) => item.event);
  if (dayEvents.length === 0) {
    log(`[diary] ${day}: 이벤트 없음 — 건너뜀`);
    return { written: false, reason: 'no events' };
  }

  // 일기는 로컬 전용이므로 session_digest 등 민감 이벤트도 프롬프트에 포함한다
  const lines = dayEvents.map((e) => `- [${e.source}] ${e.kind}: ${e.title}${e.detail ? ` (${e.detail.slice(0, 120)})` : ''}`);
  const prompt =
    `아래는 나의 하루 활동 기록이다. 1인칭 "세 줄 일기"를 한국어로 정확히 3문장, 3줄로 써라. ` +
    `과장 없이 담백하게, 감정 한 스푼만.\n${lines.slice(0, 80).join('\n')}`;

  let text;
  try {
    const res = await fetch(`${ollama.origin}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.NC_OLLAMA_MODEL ?? 'llama3', prompt, stream: false }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = ((await res.json()).response ?? '').trim();
  } catch (err) {
    log(`[diary] waiting: Ollama 호출 실패(${err.message}) — 폴백 없이 대기(§6)`);
    await summaryNote('status=waiting reason=ollama-unreachable');
    return { waiting: true, reason: `ollama unreachable: ${err.message}` };
  }
  if (!text) {
    log('[diary] waiting: Ollama 빈 응답 — 대기');
    await summaryNote('status=waiting reason=empty-response');
    return { waiting: true, reason: 'empty response' };
  }

  await mkdir(diaryDir, { recursive: true });
  const file = path.join(diaryDir, `${day}.md`);
  await writeFile(file, `# 세 줄 일기 ${day}\n\n${text}\n`, 'utf8');
  log(`[diary] written: ${file}`);
  await summaryNote(`status=written day=${day}`);
  return { written: true, file };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadDotEnv, banner } = await import('../boot/env.mjs');
  loadDotEnv();
  banner('scribe-diary');
  await runDiary();
  process.exit(0);
}
