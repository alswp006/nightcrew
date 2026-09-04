import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { runSentinel } from '../qa-sentinel/lib/engine.mjs';
import { readEvents } from '../collectors/ledger-read.mjs';
import { todayKST } from '../collectors/lib/kst.mjs';

const GOOD_HTML = `<!doctype html><html><head><title>demo</title></head>
<body><h1>데모 앱</h1><div id="result">ok</div></body></html>`;
const BAD_HTML = `<!doctype html><html><head><title>bad</title></head>
<body><h1>깨진 앱</h1></body></html>`; // #result 없음

const SMOKE_OK = `import { test, expect } from '@playwright/test';
test('main: 페이지 렌더링과 콘솔 에러 없음', async ({ page }) => {
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
  expect(errors).toEqual([]);
});
`;
const SMOKE_RESULT = `import { test, expect } from '@playwright/test';
test('result: 결과 화면 표시', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#result')).toBeVisible();
});
`;

async function writePack(appsDir, appId, profile, baseUrlEnv, spec) {
  const dir = path.join(appsDir, appId);
  await mkdir(path.join(dir, 'scenarios'), { recursive: true });
  await writeFile(
    path.join(dir, 'pack.json'),
    JSON.stringify({
      app_id: appId,
      name: appId,
      base_url_env: baseUrlEnv,
      profile,
      level: 'smoke',
      created_by: 'human',
      created_at: '2026-07-18',
    })
  );
  await writeFile(path.join(dir, 'scenarios', 'smoke.spec.ts'), spec);
}

function serve(html) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function setupRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'nc-sentinel-'));
  await symlink(new URL('../node_modules', import.meta.url).pathname, path.join(root, 'node_modules'));
  return root;
}

// 서버 정리는 t.after로 — 단언이 실패하면 close()에 도달하지 못해 열린 핸들이 남고 `node --test`가
// 영원히 안 끝난다(실측 2026-09-02: 브라우저 미설치로 실패한 스위트가 6분 넘게 매달렸다).
// 계기가 실패를 '멈춤'으로 바꾸면 사람은 원인 대신 타임아웃만 본다.
test('§11 protected: 즉시 사진 알림, 2연속 실패에만 claude 보고 첨부', { timeout: 300_000 }, async (t) => {
  const { appendEvent } = await import('../collectors/ledger-append.mjs');
  const { chmod } = await import('node:fs/promises');
  const root = await setupRoot();
  const appsDir = path.join(root, 'apps');
  const artifactsRoot = path.join(root, 'artifacts');
  const ledgerDir = path.join(root, 'ledger');
  const badServer = await serve(BAD_HTML);
  t.after(() => badServer.close());
  const badUrl = `http://127.0.0.1:${badServer.address().port}`;
  await writePack(appsDir, 'prot_bad', 'protected', 'PROT_BAD_BASE_URL', SMOKE_RESULT);

  const stub = path.join(root, 'claude-stub.sh');
  await writeFile(stub, '#!/bin/sh\necho "가설: 스텁 보고"\n');
  await chmod(stub, 0o755);

  const notifications = [];
  const opts = {
    appsDir,
    artifactsRoot,
    ledgerDir,
    env: { PROT_BAD_BASE_URL: badUrl, NC_CLAUDE_BIN: stub },
    notifyImpl: async (text, o) => {
      notifications.push({ text, opts: o });
      return { ok: true };
    },
  };

  // 1회차: 첫 실패 — 즉시 알림 + 사진, claude 보고 없음
  await runSentinel(opts);
  assert.equal(notifications.length, 1, 'protected 실패는 즉시 1건');
  assert.ok(notifications[0].opts?.photoPath?.endsWith('.png'), '사진이 첨부되어야 한다 (§11)');
  assert.ok(!notifications[0].text.includes('가설'), '첫 실패에는 claude 보고가 없어야 한다');

  // run_fail refs는 스크린샷 우선
  const { events } = await readEvents({ ledgerDir });
  const fail = events.find((e) => e.event.kind === 'run_fail');
  assert.ok(fail.event.refs[0].endsWith('.png'), '대표 증거는 스크린샷이어야 한다');

  // 2회차: 직전 run_fail 존재 → 2연속 — 사진 캡션 + claude 보고는 별도 메시지(캡션 1000자 잘림 방지)
  notifications.length = 0;
  await runSentinel(opts);
  assert.equal(notifications.length, 2, '사진 알림 1건 + claude 보고 1건');
  assert.ok(notifications[0].opts?.photoPath?.endsWith('.png'));
  assert.ok(notifications[1].text.includes('가설: 스텁 보고'), '2연속 실패에는 claude 보고가 별도 발송');
  await access(path.join(artifactsRoot, 'prot_bad', todayKST(), 'claude-report.md'));
});

test('§5: 파이프라인 진행-중 마커가 있으면 그 팩은 스킵+카운트한다', { timeout: 60_000 }, async () => {
  const { writeFile: wf } = await import('node:fs/promises');
  const root = await setupRoot();
  const appsDir = path.join(root, 'apps');
  const markersDir = path.join(root, 'markers');
  await writePack(appsDir, 'fac_busy', 'experimental', 'FAC_BUSY_BASE_URL', SMOKE_OK);
  await mkdir(markersDir, { recursive: true });
  await wf(path.join(markersDir, 'fac_busy.json'), JSON.stringify({ startedAt: new Date().toISOString() }));

  const summary = await runSentinel({
    appsDir,
    artifactsRoot: path.join(root, 'artifacts'),
    ledgerDir: path.join(root, 'ledger'),
    markersDir,
    env: { FAC_BUSY_BASE_URL: 'http://127.0.0.1:1' }, // URL이 있어도 마커가 우선
    notifyImpl: async () => ({ ok: true }),
  });
  assert.equal(summary.counters.pipelineSkipped, 1);
  assert.ok(!summary.order.includes('fac_busy'), '진행 중인 앱은 실행하지 않는다');

  // 오래된(stale) 마커는 무시하고 정상 실행 경로를 탄다
  await wf(
    path.join(markersDir, 'fac_busy.json'),
    JSON.stringify({ startedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString() })
  );
  const again = await runSentinel({
    appsDir,
    artifactsRoot: path.join(root, 'artifacts'),
    ledgerDir: path.join(root, 'ledger'),
    markersDir,
    env: { FAC_BUSY_BASE_URL: 'http://127.0.0.1:1' },
    notifyImpl: async () => ({ ok: true }),
  });
  assert.equal(again.counters.pipelineSkipped, 0, 'stale 마커는 파이프라인 크래시 잔재 — 스킵하지 않는다');
  assert.ok(again.order.includes('fac_busy'));
});

test('run_flaky 판정 + pack.json 파손 카운트 + R3 요약 이벤트', { timeout: 300_000 }, async (t) => {
  const root = await setupRoot();
  const appsDir = path.join(root, 'apps');
  const artifactsRoot = path.join(root, 'artifacts');
  const ledgerDir = path.join(root, 'ledger');

  // '/' 첫 요청만 깨진 페이지 — 재시도에서 통과 → run_flaky
  let rootHits = 0;
  const flakyServer = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.url === '/') {
        rootHits += 1;
        res.end(rootHits === 1 ? BAD_HTML : GOOD_HTML);
      } else {
        res.end(GOOD_HTML);
      }
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => flakyServer.close());
  await writePack(appsDir, 'fac_flaky', 'experimental', 'FAC_FLAKY_BASE_URL', SMOKE_RESULT);
  await mkdir(path.join(appsDir, 'broken'), { recursive: true });
  await writeFile(path.join(appsDir, 'broken', 'pack.json'), '{invalid json');

  const summary = await runSentinel({
    appsDir,
    artifactsRoot,
    ledgerDir,
    env: { FAC_FLAKY_BASE_URL: `http://127.0.0.1:${flakyServer.address().port}` },
    notifyImpl: async () => ({ ok: true }),
  });

  assert.equal(summary.counters.packParseFailures, 1, '파손 pack.json은 카운트 (R3)');
  const byApp = Object.fromEntries(summary.packs.map((p) => [p.app_id, p]));
  assert.equal(byApp.fac_flaky.status, 'run_flaky', '재시도로만 통과 → run_flaky');

  const { events } = await readEvents({ ledgerDir });
  assert.ok(events.some((e) => e.event.kind === 'run_flaky'));
  const note = events.find((e) => e.event.kind === 'note' && /run summary/.test(e.event.title));
  assert.ok(note, 'R3 카운터 요약 이벤트가 원장에 있어야 §6 다이제스트에 도달한다');
  assert.match(note.event.detail, /parse_failures=1/);
});

test('Sentinel 엔진 통합: 계약 A·B·C·D + §11 매트릭스', { timeout: 300_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'nc-sentinel-'));
  // 임시 팩의 spec이 @playwright/test를 해석할 수 있도록 리포 node_modules를 연결
  await symlink(new URL('../node_modules', import.meta.url).pathname, path.join(root, 'node_modules'));
  const appsDir = path.join(root, 'apps');
  const artifactsRoot = path.join(root, 'artifacts');
  const ledgerDir = path.join(root, 'ledger');

  const goodServer = await serve(GOOD_HTML);
  const badServer = await serve(BAD_HTML);
  t.after(() => { goodServer.close(); badServer.close(); });
  const goodUrl = `http://127.0.0.1:${goodServer.address().port}`;
  const badUrl = `http://127.0.0.1:${badServer.address().port}`;

  // 4팩: protected 정상 / experimental 정상 / experimental 실패 / base_url 미설정 → 스킵
  await writePack(appsDir, 'prot_demo', 'protected', 'PROT_DEMO_BASE_URL', SMOKE_OK);
  await writePack(appsDir, 'fac_ok', 'experimental', 'FAC_OK_BASE_URL', SMOKE_OK);
  await writePack(appsDir, 'fac_bad', 'experimental', 'FAC_BAD_BASE_URL', SMOKE_RESULT);
  await writePack(appsDir, 'fac_noenv', 'experimental', 'FAC_NOENV_BASE_URL', SMOKE_OK);
  await mkdir(path.join(appsDir, 'junk-no-pack'), { recursive: true }); // pack.json 없음 → 무시

  const notifications = [];
  const summary = await runSentinel({
    appsDir,
    artifactsRoot,
    ledgerDir,
    env: {
      PROT_DEMO_BASE_URL: goodUrl,
      FAC_OK_BASE_URL: goodUrl,
      FAC_BAD_BASE_URL: badUrl,
      NC_CLAUDE_BIN: '/nonexistent-claude',
    },
    notifyImpl: async (text) => {
      notifications.push(text);
      return { ok: true };
    },
  });

  // §3.3: pack.json 있는 폴더만, protected 먼저
  assert.equal(summary.order[0], 'prot_demo', 'protected 팩이 먼저 실행돼야 한다');
  assert.ok(!summary.order.includes('junk-no-pack'));
  assert.ok(!summary.order.includes('fac_noenv'), 'base_url 미설정 팩은 실행 목록에 없어야 한다');

  // R3: 스킵 카운트
  assert.equal(summary.counters.packsSkipped, 1);

  // 팩별 결과
  const byApp = Object.fromEntries(summary.packs.map((p) => [p.app_id, p]));
  assert.equal(byApp.prot_demo.status, 'run_pass');
  assert.equal(byApp.fac_ok.status, 'run_pass');
  assert.equal(byApp.fac_bad.status, 'run_fail');

  // 계약 C: error_signature = app_id:scope:slug, 에러 텍스트 미포함
  assert.match(byApp.fac_bad.signatures[0], /^fac_bad:result:[a-z0-9-]+$/);

  // 계약 A: heartbeat + 팩당 run_* 1건 + experimental 실패의 heal_request
  const { events } = await readEvents({ ledgerDir });
  const kinds = events.map((e) => e.event.kind);
  assert.equal(kinds.filter((k) => k === 'heartbeat').length, 1);
  assert.equal(kinds.filter((k) => k.startsWith('run_')).length, 3, '실행된 3팩 각 1건');
  const heal = events.filter((e) => e.event.kind === 'heal_request');
  assert.equal(heal.length, 1);
  assert.equal(heal[0].event.app, 'fac_bad');
  assert.ok(heal[0].event.refs?.length > 0, 'heal_request에 refs 증거가 있어야 한다');
  const fail = events.find((e) => e.event.kind === 'run_fail');
  assert.match(fail.event.detail, /error_signature=fac_bad:result:/);

  // §3.3: artifacts/{app_id}/{date}/ + app_id 포함 result.json
  const date = todayKST();
  for (const appId of ['prot_demo', 'fac_ok', 'fac_bad']) {
    const resultPath = path.join(artifactsRoot, appId, date, 'result.json');
    await access(resultPath);
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(result.app_id, appId);
  }

  // §10 배칭: experimental 실패는 건별 발송 금지 — 묶음 한 줄만
  const expBatch = notifications.filter((t) => t.includes('fac_bad'));
  assert.equal(expBatch.length, 1, 'experimental 실패는 정확히 1건의 묶음 알림');
  assert.equal(notifications.length, 1, 'protected 실패가 없으므로 총 알림 1건');
  assert.match(expBatch[0], /결과 화면 표시/, '알림에는 해시 슬러그가 아니라 사람이 읽는 시나리오 제목이 실려야 한다');
});
