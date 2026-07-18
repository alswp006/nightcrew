import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { runDiary } from '../scribe/diary.mjs';
import { todayKST } from '../collectors/lib/kst.mjs';

async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'nc-diary-'));
}

const T = todayKST();
const line = (o) => JSON.stringify(o) + '\n';

async function seedLedger(dir) {
  await writeFile(
    path.join(dir, `${T}.jsonl`),
    line({ ts: `${T}T23:00:00+09:00`, source: 'scribe', kind: 'commit_digest', title: 'nightcrew: 2 commits' }) +
      line({ ts: `${T}T23:10:00+09:00`, source: 'scribe', kind: 'session_digest', title: '세션: 야간조 마무리' })
  );
}

test('§6: 로컬 엔진(Ollama)이 없으면 일기 작가는 "대기"한다 — 폴백 금지', async () => {
  const ledgerDir = await tmp();
  const diaryDir = await tmp();
  await seedLedger(ledgerDir);

  const r = await runDiary({ ledgerDir, diaryDir, env: {} });
  assert.equal(r.waiting, true);
  assert.ok(!existsSync(path.join(diaryDir, `${T}.md`)), '외부 엔진 폴백으로 일기를 쓰면 안 된다');
});

test('§6: OLLAMA_URL이 로컬호스트가 아니면 거부한다 — 원문 외부 전송 금지', async () => {
  const ledgerDir = await tmp();
  const diaryDir = await tmp();
  await seedLedger(ledgerDir);

  const r = await runDiary({ ledgerDir, diaryDir, env: { OLLAMA_URL: 'http://api.example.com:11434' } });
  assert.equal(r.waiting, true);
  assert.match(r.reason, /로컬|local/i);
  assert.ok(!existsSync(path.join(diaryDir, `${T}.md`)));
});

test('Ollama HTTP 오류·빈 응답도 폴백 없이 대기한다', async () => {
  const ledgerDir = await tmp();
  const diaryDir = await tmp();
  await seedLedger(ledgerDir);

  for (const behavior of ['500', 'empty']) {
    const server = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        if (behavior === '500') {
          res.writeHead(500);
          res.end('boom');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ response: '' }));
        }
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const r = await runDiary({ ledgerDir, diaryDir, env: { OLLAMA_URL: `http://127.0.0.1:${server.address().port}` } });
    server.close();
    assert.equal(r.waiting, true, `${behavior}: 대기해야 한다`);
    assert.ok(!existsSync(path.join(diaryDir, `${T}.md`)), `${behavior}: 파일을 만들면 안 된다`);
  }
});

test('로컬 Ollama가 있으면 세 줄 일기를 쓴다 (session_digest 포함 — 로컬 전용이므로 허용)', async () => {
  const ledgerDir = await tmp();
  const diaryDir = await tmp();
  await seedLedger(ledgerDir);

  const prompts = [];
  const server = await new Promise((resolve) => {
    const s = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      prompts.push(JSON.parse(body).prompt);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: '오늘은 야간조를 마무리했다.\n테스트가 전부 초록이라 마음이 놓였다.\n내일은 배포를 해봐야지.' }));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });

  const r = await runDiary({
    ledgerDir,
    diaryDir,
    env: { OLLAMA_URL: `http://127.0.0.1:${server.address().port}` },
  });
  server.close();

  assert.equal(r.waiting, undefined);
  assert.ok(r.written);
  const md = await readFile(path.join(diaryDir, `${T}.md`), 'utf8');
  assert.match(md, /야간조를 마무리했다/);
  assert.ok(prompts[0].includes('세션: 야간조 마무리'), '로컬 전용이므로 세션 이벤트도 프롬프트에 실린다');
});
