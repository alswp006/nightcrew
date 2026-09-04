import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectSessions, isHumanTurn, topicOf, cwdAllowed, isSubagentEntrypoint } from '../scribe/collect-sessions.mjs';
import { readEvents } from '../collectors/ledger-read.mjs';

async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'nc-sessions-'));
}

/** readEvents는 {event, file, line} 래퍼를 준다 — 이벤트 본문만 꺼낸다. */
async function evs(ledgerDir) {
  return (await readEvents({ ledgerDir })).events.map((e) => e.event);
}

/** ~/.claude/projects/<slug>/<sessionId>.jsonl 모양을 만든다. */
async function makeProjects(entriesBySession, { slug = '-home-user-proj' } = {}) {
  const root = await tmp();
  const dir = path.join(root, slug);
  await mkdir(dir, { recursive: true });
  for (const [sessionId, entries] of Object.entries(entriesBySession)) {
    await writeFile(path.join(dir, `${sessionId}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }
  return { root, dir };
}

const T = '2026-09-02T10:00:00.000Z';
const userLine = (cwd, text, ts = T) => ({
  type: 'user', cwd, gitBranch: 'main', version: '2.1.0', timestamp: ts,
  message: { content: text },
});
const toolResultLine = (cwd, ts = T) => ({
  type: 'user', cwd, timestamp: ts,
  message: { content: [{ type: 'tool_result', content: 'ok' }] },
});
const assistantLine = (cwd, tools = [], ts = T) => ({
  type: 'assistant', cwd, timestamp: ts,
  message: { content: tools.map((n) => ({ type: 'tool_use', name: n })) },
});

// ── 순수 함수 ──

test('isHumanTurn: tool_result는 사람 턴이 아니다 (실측 2,212/2,321이 tool_result)', () => {
  assert.equal(isHumanTurn(userLine('/x', '안녕')), true);
  assert.equal(isHumanTurn(toolResultLine('/x')), false);
  assert.equal(isHumanTurn(assistantLine('/x')), false);
  assert.equal(isHumanTurn({ type: 'user', isSidechain: true, message: { content: 'hi' } }), false);
});

test('topicOf: 시크릿성 프롬프트는 절단 전에 통째로 마스킹한다', () => {
  assert.equal(topicOf(userLine('/x', '  라우터   배선  고쳐줘 ')), '라우터 배선 고쳐줘');
  const secret = topicOf(userLine('/x', 'key는 sk-abcdefghijklmnopqrstuv 야'));
  assert.equal(secret, '[redacted: secret-like prompt]');
});

test('cwdAllowed: 디렉터리 경계를 지킨다 — /a가 /ab를 삼키지 않는다', () => {
  assert.equal(cwdAllowed('/home/u/proj', ['/home/u/proj']), true);
  assert.equal(cwdAllowed('/home/u/proj/sub', ['/home/u/proj']), true);
  assert.equal(cwdAllowed('/home/u/project-x', ['/home/u/proj']), false);
  assert.equal(cwdAllowed('/home/u/other', ['/home/u/proj']), false);
  assert.equal(cwdAllowed('/home/u/proj', []), false, '화이트리스트가 비면 아무것도 통과하지 않는다');
});

// ── 수집기 ──

test('화이트리스트 세션을 session_digest 1건으로 적립한다 (§6)', async () => {
  const cwd = '/home/user/proj';
  const { root } = await makeProjects({
    s1: [userLine(cwd, '라우터 고쳐줘'), assistantLine(cwd, ['Bash', 'Edit', 'Bash']), toolResultLine(cwd)],
  });
  const ledgerDir = await tmp();
  const storeDir = await tmp();

  const c = await collectSessions({ projectsDir: root, allowCwds: [cwd], ledgerDir, storeDir, log: () => {} });
  assert.equal(c.digestsWritten, 1);

  const events = await evs(ledgerDir);
  const dg = events.filter((e) => e.kind === 'session_digest');
  assert.equal(dg.length, 1);
  assert.match(dg[0].title, /^proj: 1 turns, 3 tool calls$/);
  assert.match(dg[0].detail, /tools=3 \(Bash×2 Edit×1\)/);
  assert.match(dg[0].detail, /turns=u1\/a1/);
  assert.match(dg[0].detail, /branch=main/);
});

test('기본(meta)은 대화 내용을 한 글자도 담지 않는다 — topics일 때만 첫 프롬프트 한 줄', async () => {
  const cwd = '/home/user/proj';
  const { root } = await makeProjects({ s1: [userLine(cwd, '비밀 프로젝트 아이디어'), assistantLine(cwd, ['Read'])] });
  const ledgerDir = await tmp();

  await collectSessions({ projectsDir: root, allowCwds: [cwd], ledgerDir, storeDir: await tmp(), log: () => {} });
  let dg = (await evs(ledgerDir)).filter((e) => e.kind === 'session_digest');
  assert.equal(dg.length, 1);
  assert.ok(!dg[0].detail.includes('비밀'), '기본 모드가 프롬프트를 실었다');

  const ledger2 = await tmp();
  await collectSessions({ projectsDir: root, allowCwds: [cwd], detail: 'topics', ledgerDir: ledger2, storeDir: await tmp(), log: () => {} });
  dg = (await evs(ledger2)).filter((e) => e.kind === 'session_digest');
  assert.match(dg[0].detail, /topic="비밀 프로젝트 아이디어"/);
});

test('화이트리스트 밖 cwd는 적립하지 않고 커서만 전진한다', async () => {
  const { root } = await makeProjects({ s1: [userLine('/home/user/secret-work', '회사 일'), assistantLine('/home/user/secret-work', ['Bash'])] });
  const ledgerDir = await tmp();
  const storeDir = await tmp();

  const c = await collectSessions({ projectsDir: root, allowCwds: ['/home/user/proj'], ledgerDir, storeDir, log: () => {} });
  assert.equal(c.digestsWritten, 0);
  assert.equal(c.filesSkippedCwd, 1);
  const events = await evs(ledgerDir);
  assert.equal(events.filter((e) => e.kind === 'session_digest').length, 0);
  assert.ok(!JSON.stringify(events).includes('회사 일'), '제외된 세션의 내용이 원장에 샜다');

  const cursor = JSON.parse(await readFile(path.join(storeDir, 'session-cursor.json'), 'utf8'));
  assert.ok(cursor.s1.lines > 0, '커서가 전진하지 않아 다음 실행이 또 훑는다');
});

test('세션이 이어지면 델타만 적립한다 — 파일 하나에 다이제스트 여럿(재개 대응)', async () => {
  const cwd = '/home/user/proj';
  const { root, dir } = await makeProjects({ s1: [userLine(cwd, '1차'), assistantLine(cwd, ['Bash'])] });
  const ledgerDir = await tmp();
  const storeDir = await tmp();
  const opts = { projectsDir: root, allowCwds: [cwd], ledgerDir, storeDir, log: () => {} };

  assert.equal((await collectSessions(opts)).digestsWritten, 1);
  // 두 번째 실행: 파일이 안 컸으므로 훑지도 않는다
  const second = await collectSessions(opts);
  assert.equal(second.digestsWritten, 0);
  assert.equal(second.filesUnchanged, 1);

  // 세션 재개 — 같은 파일에 append
  await appendFile(path.join(dir, 's1.jsonl'),
    JSON.stringify(userLine(cwd, '2차')) + '\n' + JSON.stringify(assistantLine(cwd, ['Edit', 'Edit'])) + '\n', 'utf8');

  const third = await collectSessions(opts);
  assert.equal(third.digestsWritten, 1, '재개분이 적립되지 않았다');
  const dg = (await evs(ledgerDir)).filter((e) => e.kind === 'session_digest');
  assert.equal(dg.length, 2);
  assert.match(dg[1].detail, /tools=2 \(Edit×2\)/, '델타가 아니라 전체를 다시 셌다');
});

test('LEDGER_DIR 미설정이면 커서를 유보한다 — 원장이 생기면 재수집', async () => {
  const cwd = '/home/user/proj';
  const { root } = await makeProjects({ s1: [userLine(cwd, 'x'), assistantLine(cwd, ['Bash'])] });
  const storeDir = await tmp();

  const c = await collectSessions({ projectsDir: root, allowCwds: [cwd], ledgerDir: '', storeDir, log: () => {} });
  assert.equal(c.digestsWritten, 0);
  assert.equal(c.ledgerSkipped, 1);
  const cursor = JSON.parse(await readFile(path.join(storeDir, 'session-cursor.json'), 'utf8'));
  assert.equal(cursor.s1, undefined, '원장에 못 썼는데 커서가 전진하면 그 세션은 영원히 유실된다');

  const ledgerDir = await tmp();
  const again = await collectSessions({ projectsDir: root, allowCwds: [cwd], ledgerDir, storeDir, log: () => {} });
  assert.equal(again.digestsWritten, 1);
});

test('깨진 줄은 세고 넘어간다 — 한 줄이 그 세션을 통째로 버리지 않는다 (R3)', async () => {
  const cwd = '/home/user/proj';
  const { root, dir } = await makeProjects({ s1: [userLine(cwd, 'ok'), assistantLine(cwd, ['Bash'])] });
  await appendFile(path.join(dir, 's1.jsonl'), '{깨진 JSON\n' + JSON.stringify(assistantLine(cwd, ['Edit'])) + '\n', 'utf8');
  const ledgerDir = await tmp();

  const c = await collectSessions({ projectsDir: root, allowCwds: [cwd], ledgerDir, storeDir: await tmp(), log: () => {} });
  assert.equal(c.digestsWritten, 1);
  assert.equal(c.parseErrors, 1);
  const dg = (await evs(ledgerDir)).filter((e) => e.kind === 'session_digest');
  assert.match(dg[0].detail, /Edit×1/, '깨진 줄 뒤가 버려졌다');
});

test('전사 디렉터리가 없으면 조용히 아무 일도 안 한다 (설계 원칙 2)', async () => {
  const c = await collectSessions({
    projectsDir: path.join(await tmp(), 'nope'), allowCwds: ['/x'],
    ledgerDir: await tmp(), storeDir: await tmp(), log: () => {},
  });
  assert.equal(c.filesSeen, 0);
  assert.equal(c.digestsWritten, 0);
});

test('R3 카운터를 note로 남긴다 — 다이제스트가 읽는 유일한 경로', async () => {
  const cwd = '/home/user/proj';
  const { root } = await makeProjects({ s1: [userLine(cwd, 'x'), assistantLine(cwd, ['Bash'])] });
  const ledgerDir = await tmp();
  await collectSessions({ projectsDir: root, allowCwds: [cwd], ledgerDir, storeDir: await tmp(), log: () => {} });

  const note = (await evs(ledgerDir)).find((e) => e.kind === 'note' && e.title === 'session collector summary');
  assert.ok(note, 'R3 note가 없다');
  assert.match(note.detail, /detail=meta/);
  assert.match(note.detail, /digests=1/);
  assert.match(note.detail, /parse_errors=0/);
});

test('첫 실행 백필 상한: 처음 보는 오래된 세션은 내용을 안 읽고 커서만 끝에 놓는다', async () => {
  const cwd = '/home/user/proj';
  const { root, dir } = await makeProjects({
    old1: [userLine(cwd, '작년 일'), assistantLine(cwd, ['Bash'])],
    fresh: [userLine(cwd, '오늘 일'), assistantLine(cwd, ['Edit'])],
  });
  const { utimes } = await import('node:fs/promises');
  const longAgo = new Date(Date.now() - 90 * 86400000);
  await utimes(path.join(dir, 'old1.jsonl'), longAgo, longAgo);

  const ledgerDir = await tmp();
  const storeDir = await tmp();
  const c = await collectSessions({ projectsDir: root, allowCwds: [cwd], ledgerDir, storeDir, log: () => {} });

  assert.equal(c.filesBackfillSkipped, 1);
  assert.equal(c.digestsWritten, 1, '오래된 세션까지 적립됐다 — 켜는 날 원장이 과거로 뒤덮인다');
  const dg = (await evs(ledgerDir)).filter((e) => e.kind === 'session_digest');
  assert.equal(dg.length, 1);
  assert.ok(!JSON.stringify(dg).includes('작년'), '백필 제외 세션의 내용이 샜다');

  const cursor = JSON.parse(await readFile(path.join(storeDir, 'session-cursor.json'), 'utf8'));
  assert.ok(cursor.old1.lines > 0, '커서를 끝에 안 놓으면 다음 실행이 또 훑는다');
});

test('백필 제외된 세션도 이후 새 활동은 적립한다 — 영구 제외가 아니다', async () => {
  const cwd = '/home/user/proj';
  const { root, dir } = await makeProjects({ old1: [userLine(cwd, '작년 일'), assistantLine(cwd, ['Bash'])] });
  const { utimes } = await import('node:fs/promises');
  const longAgo = new Date(Date.now() - 90 * 86400000);
  await utimes(path.join(dir, 'old1.jsonl'), longAgo, longAgo);

  const ledgerDir = await tmp();
  const storeDir = await tmp();
  const opts = { projectsDir: root, allowCwds: [cwd], ledgerDir, storeDir, log: () => {} };
  assert.equal((await collectSessions(opts)).digestsWritten, 0);

  // 그 세션을 오늘 다시 열었다
  await appendFile(path.join(dir, 'old1.jsonl'),
    JSON.stringify(userLine(cwd, '오늘 재개')) + '\n' + JSON.stringify(assistantLine(cwd, ['Write'])) + '\n', 'utf8');

  assert.equal((await collectSessions(opts)).digestsWritten, 1);
  const dg = (await evs(ledgerDir)).filter((e) => e.kind === 'session_digest');
  assert.match(dg[0].detail, /tools=1 \(Write×1\)/, '재개분이 아니라 전체를 셌다');
});

test('SESSIONS_BACKFILL_DAYS=0이면 전체 백필(의도적 탈출구)', async () => {
  const cwd = '/home/user/proj';
  const { root, dir } = await makeProjects({ old1: [userLine(cwd, 'x'), assistantLine(cwd, ['Bash'])] });
  const { utimes } = await import('node:fs/promises');
  const longAgo = new Date(Date.now() - 90 * 86400000);
  await utimes(path.join(dir, 'old1.jsonl'), longAgo, longAgo);

  const c = await collectSessions({
    projectsDir: root, allowCwds: [cwd], backfillDays: 0,
    ledgerDir: await tmp(), storeDir: await tmp(), log: () => {},
  });
  assert.equal(c.digestsWritten, 1);
  assert.equal(c.filesBackfillSkipped, 0);
});

// ── 서브에이전트 전사 제외(2026-09-02 실측: 첫 수집 21건 중 19건이 워크플로 서브에이전트였다) ──

const agentLine = (cwd, text, ts = T, entrypoint = 'sdk-cli') => ({
  type: 'user', cwd, gitBranch: 'main', version: '2.1.0', timestamp: ts, entrypoint,
  message: { content: text },
});
const humanLine = (cwd, text, ts = T) => ({ ...agentLine(cwd, text, ts, 'cli') });

test('isSubagentEntrypoint: sdk 계열만 서브에이전트 — 모르는 값은 사람 쪽으로 남긴다', () => {
  assert.equal(isSubagentEntrypoint('sdk-cli'), true);
  assert.equal(isSubagentEntrypoint('SDK-TS'), true);
  assert.equal(isSubagentEntrypoint('cli'), false);
  assert.equal(isSubagentEntrypoint('vscode'), false);
  assert.equal(isSubagentEntrypoint(''), false);
  assert.equal(isSubagentEntrypoint(undefined), false);
});

test('서브에이전트 전사는 적립하지 않고 커서만 전진한다 — 일지가 가짜 세션으로 덮이지 않게', async () => {
  const cwd = '/home/user/proj';
  const { root } = await makeProjects({
    sub: [agentLine(cwd, '서브에이전트 과업'), assistantLine(cwd, ['Bash', 'StructuredOutput'])],
    human: [humanLine(cwd, '사람이 시킨 일'), assistantLine(cwd, ['Edit'])],
  });
  const ledgerDir = await tmp();
  const storeDir = await tmp();

  const c = await collectSessions({ projectsDir: root, allowCwds: [cwd], ledgerDir, storeDir, log: () => {} });
  assert.equal(c.digestsWritten, 1);
  assert.equal(c.filesSkippedAgent, 1);

  const dg = (await evs(ledgerDir)).filter((e) => e.kind === 'session_digest');
  assert.equal(dg.length, 1);
  assert.ok(!JSON.stringify(dg).includes('StructuredOutput'), '서브에이전트 도구 사용이 샜다');

  const cursor = JSON.parse(await readFile(path.join(storeDir, 'session-cursor.json'), 'utf8'));
  assert.ok(cursor.sub.lines > 0, '커서가 전진하지 않아 다음 실행이 또 훑는다');
  assert.equal(cursor.sub.entrypoint, 'sdk-cli', '판정 근거를 커서에 남겨야 델타만 읽는 실행에서도 같은 판정이 나온다');
});

test('델타에 entrypoint가 없어도 커서에 적어 둔 값으로 계속 제외한다', async () => {
  const cwd = '/home/user/proj';
  const { root, dir } = await makeProjects({ sub: [agentLine(cwd, '1차'), assistantLine(cwd, ['Bash'])] });
  const ledgerDir = await tmp();
  const storeDir = await tmp();
  const opts = { projectsDir: root, allowCwds: [cwd], ledgerDir, storeDir, log: () => {} };

  assert.equal((await collectSessions(opts)).filesSkippedAgent, 1);

  // 재개분에는 entrypoint가 실린 사람 턴이 없다(도구 결과·assistant만)
  await appendFile(path.join(dir, 'sub.jsonl'),
    JSON.stringify(assistantLine(cwd, ['Edit', 'Edit'])) + '\n' + JSON.stringify(toolResultLine(cwd)) + '\n', 'utf8');

  const again = await collectSessions(opts);
  assert.equal(again.digestsWritten, 0, '커서의 entrypoint를 안 보면 재개분이 사람 세션으로 새어 들어간다');
  assert.equal(again.filesSkippedAgent, 1);
});

test('소요 시간은 벽시계 스팬이 아니라 붙어 있던 시간이다 — 재개 세션이 175h로 찍히던 것', async () => {
  const cwd = '/home/user/proj';
  const t0 = '2026-09-02T10:00:00.000Z';
  const t1 = '2026-09-02T10:10:00.000Z';
  const t2 = '2026-09-05T10:00:00.000Z';   // 사흘 뒤 재개 — 그 사이는 일한 시간이 아니다
  const { root } = await makeProjects({
    s1: [humanLine(cwd, '작업', t0), assistantLine(cwd, ['Bash'], t1), assistantLine(cwd, ['Edit'], t2)],
  });
  const ledgerDir = await tmp();

  await collectSessions({ projectsDir: root, allowCwds: [cwd], ledgerDir, storeDir: await tmp(), log: () => {} });
  const dg = (await evs(ledgerDir)).filter((e) => e.kind === 'session_digest');
  assert.match(dg[0].detail, /dur=10m/, `벽시계 스팬이 실렸다: ${dg[0].detail}`);
});
