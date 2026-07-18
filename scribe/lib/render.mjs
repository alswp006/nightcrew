// 개발일지 마크다운 렌더러 — 캐시된 하루치 이벤트에서 전체 재생성(멱등).
const STATUS_ICON = { run_pass: '✅', run_flaky: '⚠️', run_fail: '❌' };

export function renderJournal(day, events, r3, summary) {
  const runs = events.filter((e) => /^run_/.test(e.kind));
  const commits = events.filter((e) => e.kind === 'commit_digest');
  const summaries = events.filter((e) => e.kind === 'note' && /summary/i.test(e.title ?? ''));
  const others = events.filter(
    (e) => !/^run_/.test(e.kind) && e.kind !== 'commit_digest' && e.kind !== 'heartbeat' && !summaries.includes(e)
  );

  const lines = [`# 개발일지 ${day}`, '', '## 요약', summary, ''];

  lines.push('## Sentinel');
  if (runs.length === 0) lines.push('- 실행 기록 없음');
  for (const e of runs) {
    lines.push(`- ${STATUS_ICON[e.kind] ?? ''} ${e.title}${e.detail ? ` (${e.detail})` : ''}`);
  }
  lines.push('');

  lines.push('## 커밋');
  if (commits.length === 0) lines.push('- 수집된 커밋 없음');
  for (const e of commits) lines.push(`- ${e.title}${e.detail ? ` — ${e.detail}` : ''}`);
  lines.push('');

  if (others.length) {
    lines.push('## 기타');
    for (const e of others) lines.push(`- [${e.source}] ${e.title} (${e.kind})`);
    lines.push('');
  }

  lines.push('## R3 카운터');
  lines.push(`- scribe: parse_failures=${r3.parseFailures} read_failures=${r3.readFailures}`);
  for (const e of summaries) lines.push(`- ${e.title}: ${e.detail ?? ''}`);
  lines.push('');

  return lines.join('\n');
}
