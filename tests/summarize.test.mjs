import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { summarize, templateSummary } from '../scribe/lib/summarize.mjs';

const EVENTS = [
  { source: 'sentinel', kind: 'run_pass', title: 'fac_demo 통과' },
  { source: 'scribe', kind: 'commit_digest', title: 'nightcrew: 2 commits', detail: 'feat a; fix b' },
];

async function stubBin(script) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nc-sum-'));
  const bin = path.join(dir, 'stub.sh');
  await writeFile(bin, `#!/bin/sh\n${script}\n`);
  await chmod(bin, 0o755);
  return bin;
}

test('auto: claude 성공 시 그 출력을 쓴다', async () => {
  const bin = await stubBin('echo "클로드 요약"');
  const engines = [];
  const out = await summarize(EVENTS, { engine: 'auto', env: { NC_CLAUDE_BIN: bin }, log: (e) => engines.push(e) });
  assert.equal(out, '클로드 요약');
  assert.deepEqual(engines, ['claude']);
});

test('auto: claude 실패 → ollama 폴백', async () => {
  const bin = await stubBin('exit 1');
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: '올라마 요약' }));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const engines = [];
  const out = await summarize(EVENTS, {
    engine: 'auto',
    env: { NC_CLAUDE_BIN: bin, OLLAMA_URL: `http://127.0.0.1:${server.address().port}` },
    log: (e) => engines.push(e),
  });
  server.close();
  assert.equal(out, '올라마 요약');
  assert.deepEqual(engines, ['ollama']);
});

test('auto: 전부 실패 → 템플릿 폴백 (조용히 죽지 않는다)', async () => {
  const bin = await stubBin('exit 1');
  const engines = [];
  const out = await summarize(EVENTS, { engine: 'auto', env: { NC_CLAUDE_BIN: bin }, log: (e) => engines.push(e) });
  assert.equal(out, templateSummary(EVENTS));
  assert.deepEqual(engines, ['template']);
});

test('민감 이벤트(session_digest)는 외부 엔진 프롬프트에서 제외된다 (§6 민감도 등급)', async () => {
  // 스텁이 받은 프롬프트를 그대로 돌려주게 해서 프롬프트 내용을 검사한다
  const bin = await stubBin('printf %s "$2"');
  const events = [...EVENTS, { source: 'scribe', kind: 'session_digest', title: '비밀 세션 내용' }];
  const out = await summarize(events, { engine: 'auto', env: { NC_CLAUDE_BIN: bin } });
  assert.ok(!out.includes('비밀 세션 내용'), '세션 로그 계열은 외부 전송 금지 (§6)');
  assert.ok(out.includes('fac_demo 통과'), '일반 이벤트는 프롬프트에 포함');
});
