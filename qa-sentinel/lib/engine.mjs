// Sentinel v2 엔진 (§5). 팩 발견 → protected 먼저 실행 → 팩 간 격리 → 원장 기록 → §11 알림 라우팅.
// 원장·artifacts에만 쓴다. 앱 코드 수정 금지(§12).
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { appendEvent } from '../../collectors/ledger-append.mjs';
import { readEvents } from '../../collectors/ledger-read.mjs';
import { todayKST, nowISOKST } from '../../collectors/lib/kst.mjs';
import { errorSignature } from './signature.mjs';
import { writeResultJson, isSecondConsecutiveFail, claudeReport } from './report.mjs';
import { sendNotify } from '../../notify/notify.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 느린 팩이 crash로 오분류되지 않게 여유를 두고, Playwright가 리포트를 남기고 스스로 멈추도록
// globalTimeout을 프로세스 강제 종료보다 앞에 둔다.
const PACK_TIMEOUT_MS = 10 * 60 * 1000;
const PACK_GLOBAL_TIMEOUT_MS = PACK_TIMEOUT_MS - 30_000;

function playwrightConfigSource({ testDir, reportPath, outputDir, baseUrl }) {
  return `export default {
  testDir: ${JSON.stringify(testDir)},
  timeout: 30000,
  globalTimeout: ${PACK_GLOBAL_TIMEOUT_MS},
  retries: 1,
  workers: 1,
  expect: { timeout: 3000 },
  reporter: [['json', { outputFile: ${JSON.stringify(reportPath)} }]],
  outputDir: ${JSON.stringify(outputDir)},
  use: { baseURL: ${JSON.stringify(baseUrl)}, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
};
`;
}

function execPlaywright(configPath) {
  return new Promise((resolve) => {
    execFile(
      'npx',
      ['playwright', 'test', `--config=${configPath}`],
      { cwd: REPO_ROOT, timeout: PACK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1' } },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
    );
  });
}

function collectSpecs(report) {
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        out.push({ file: spec.file ?? suite.file ?? '', title: spec.title, status: t.status });
      }
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of report.suites ?? []) walk(s);
  return out;
}

// refs는 리포 루트 기준 상대경로(DISCOVERY E.6), 루트 밖이면 절대경로 그대로.
function ref(p) {
  const rel = path.relative(REPO_ROOT, p);
  return rel.startsWith('..') ? p : rel;
}

async function findEvidence(dir) {
  try {
    const names = await readdir(dir, { recursive: true });
    return {
      pngs: names.filter((n) => n.endsWith('.png')).map((n) => path.join(dir, n)),
      traces: names.filter((n) => n.endsWith('.zip')).map((n) => path.join(dir, n)), // trace.zip — 콘솔·네트워크 증거(§7.3)
    };
  } catch {
    return { pngs: [], traces: [] };
  }
}

async function runPack(pack, { baseUrl, artifactsRoot, date }) {
  const artDir = path.join(artifactsRoot, pack.app_id, date);
  await mkdir(artDir, { recursive: true });
  const reportPath = path.join(artDir, 'playwright-report.json');
  const configPath = path.join(artDir, 'playwright.config.mjs');
  const outputDir = path.join(artDir, 'test-output');
  await writeFile(
    configPath,
    playwrightConfigSource({ testDir: path.join(pack.dir, 'scenarios'), reportPath, outputDir, baseUrl })
  );

  const exec = await execPlaywright(configPath);

  let report = null;
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch {
    // 리포트조차 없으면 팩 수준 크래시 — 안정 시그니처로 실패 처리
  }
  if (!report) {
    return {
      app_id: pack.app_id,
      profile: pack.profile,
      status: 'run_fail',
      specs: [],
      signatures: [`${pack.app_id}:engine:playwright-crash`],
      refs: [ref(artDir)],
      screenshots: [],
      artDir,
      stderrTail: exec.stderr.slice(-2000),
    };
  }

  const specs = collectSpecs(report);
  if (specs.length === 0) {
    // 시나리오가 하나도 로드되지 않은 팩을 통과로 처리하면 침묵 실패가 된다(R3)
    return {
      app_id: pack.app_id,
      profile: pack.profile,
      status: 'run_fail',
      specs: [],
      signatures: [`${pack.app_id}:engine:no-tests-found`],
      refs: [ref(reportPath)],
      screenshots: [],
      artDir,
      stderrTail: (report.errors ?? []).map((e) => e.message ?? '').join('\n').slice(-2000) || exec.stderr.slice(-2000),
    };
  }

  const failed = specs.filter((s) => s.status === 'unexpected');
  const flaky = specs.filter((s) => s.status === 'flaky');
  const status = failed.length ? 'run_fail' : flaky.length ? 'run_flaky' : 'run_pass';
  const signatures = failed.map((s) => errorSignature(pack.app_id, s.title, path.basename(s.file)));
  const failedTitles = failed.map((s) => s.title);
  const { pngs, traces } = await findEvidence(outputDir);
  // 대표 증거는 사람이 바로 볼 수 있는 스크린샷 우선(§11), 그다음 trace(콘솔·네트워크), 리포트
  const refs = [...pngs.map(ref), ...traces.map(ref), ref(reportPath)];
  return { app_id: pack.app_id, profile: pack.profile, status, specs, signatures, failedTitles, refs, screenshots: pngs, artDir };
}

async function discoverPacks(appsDir, counters, log) {
  let names = [];
  try {
    names = (await readdir(appsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const packs = [];
  for (const name of names.sort()) {
    try {
      const pack = JSON.parse(await readFile(path.join(appsDir, name, 'pack.json'), 'utf8'));
      packs.push({ ...pack, dir: path.join(appsDir, name) });
    } catch (err) {
      if (err.code === 'ENOENT') continue; // pack.json 없는 폴더는 팩이 아니다(§3.3)
      counters.packParseFailures += 1; // R3
      log(`[sentinel] pack.json parse failure: ${name}`);
    }
  }
  // §3.3: protected 먼저, 그다음 experimental
  return packs.sort((a, b) => (a.profile === b.profile ? 0 : a.profile === 'protected' ? -1 : 1));
}

export async function runSentinel({
  appsDir = path.join(REPO_ROOT, 'qa-sentinel', 'apps'),
  artifactsRoot = path.join(REPO_ROOT, 'artifacts'),
  ledgerDir = process.env.LEDGER_DIR,
  env = process.env,
  now = new Date(),
  notifyImpl,
  log = console.log,
} = {}) {
  const rawNotify = notifyImpl ?? ((text, opts) => sendNotify(text, { env, ...opts }));
  const counters = { packsRun: 0, packsSkipped: 0, packParseFailures: 0, writeFailures: 0, notifyFailures: 0, claudeSkipped: 0 };
  const date = todayKST(now);

  const notify = async (text, opts) => {
    try {
      const n = await rawNotify(text, opts);
      if (!n?.ok) counters.notifyFailures += 1;
      return n;
    } catch (err) {
      counters.notifyFailures += 1; // R3
      log(`[sentinel] notify threw: ${err.message}`);
      return { ok: false, reason: String(err) };
    }
  };

  const ledgerWrite = async (event) => {
    const r = await appendEvent(event, { ledgerDir });
    if (!r.ok && !r.skipped) {
      counters.writeFailures += 1; // R3: 조용히 삼키지 않는다
      log(`[sentinel] ledger write failed: ${r.reason}`);
    }
    return r;
  };

  await ledgerWrite({ ts: nowISOKST(), source: 'sentinel', kind: 'heartbeat', title: 'sentinel run start' });

  // §11 "2연속 실패" 판정용 — 오늘 실행 이전까지의 기록
  const prior = ledgerDir ? await readEvents({ ledgerDir }) : { events: [] };

  const packs = await discoverPacks(appsDir, counters, log);
  const order = [];
  const results = [];
  const experimentalFails = [];

  for (const pack of packs) {
    const baseUrl = env[pack.base_url_env];
    if (!baseUrl) {
      counters.packsSkipped += 1; // R3
      log(`[sentinel] skip ${pack.app_id}: ${pack.base_url_env} unset`);
      results.push({ app_id: pack.app_id, profile: pack.profile, status: 'skipped', skipped: true });
      continue;
    }

    order.push(pack.app_id);
    counters.packsRun += 1;

    // 팩 간 격리(§3.3): 실행·기록·알림 전 과정에서 한 팩의 실패가 다음 팩을 막지 않는다
    let pr;
    try {
      pr = await runPack(pack, { baseUrl, artifactsRoot, date });
    } catch (err) {
      pr = {
        app_id: pack.app_id,
        profile: pack.profile,
        status: 'run_fail',
        specs: [],
        signatures: [`${pack.app_id}:engine:pack-crash`],
        refs: [],
        screenshots: [],
        artDir: path.join(artifactsRoot, pack.app_id, date),
        stderrTail: String(err),
      };
    }
    results.push(pr);

    try {
      await writeResultJson(pr.artDir, {
        app_id: pack.app_id,
        date,
        status: pr.status,
        specs: pr.specs,
        signatures: pr.signatures,
        refs: pr.refs,
        ...(pr.stderrTail ? { stderr_tail: pr.stderrTail } : {}),
      });
    } catch (err) {
      counters.writeFailures += 1; // R3
      log(`[sentinel] result.json write failed (${pack.app_id}): ${err.message}`);
    }
    if (pr.stderrTail) log(`[sentinel] ${pack.app_id} stderr tail:\n${pr.stderrTail}`);

    const failedCount = pr.specs.filter((s) => s.status === 'unexpected').length;
    await ledgerWrite({
      ts: nowISOKST(),
      source: 'sentinel',
      app: pack.app_id,
      kind: pr.status,
      title:
        pr.status === 'run_pass'
          ? `${pack.app_id} 통과`
          : pr.status === 'run_flaky'
            ? `${pack.app_id} 재시도 후 통과`
            : `${pack.app_id} 실패 ${failedCount || '?'}건`,
      ...(pr.signatures.length ? { detail: `error_signature=${pr.signatures[0]}` } : {}),
      ...(pr.refs.length ? { refs: pr.refs } : {}),
    });

    if (pr.status !== 'run_fail') continue;

    if (pack.profile === 'experimental') {
      // §5/§7.3: Self-heal 티켓은 heal_request가 유일한 소스
      await ledgerWrite({
        ts: nowISOKST(),
        source: 'sentinel',
        app: pack.app_id,
        kind: 'heal_request',
        title: `heal 요청: ${pack.app_id}`,
        detail: `error_signature=${pr.signatures[0]}`,
        refs: pr.refs,
      });
      experimentalFails.push(pr);
    } else {
      // §11 protected: 즉시 사진+요약 알림. 2연속 실패면 claude -p 보고를 "별도 메시지"로
      // 후속 발송한다 — 사진 캡션 1000자에서 보고가 소리 없이 잘리는 것 방지.
      let claudeText = null;
      if (isSecondConsecutiveFail(prior.events, pack.app_id)) {
        const c = await claudeReport({
          appId: pack.app_id,
          signatures: pr.signatures,
          refs: pr.refs,
          bin: env.NC_CLAUDE_BIN ?? 'claude',
        });
        if (c.ok) {
          try {
            await writeFile(path.join(pr.artDir, 'claude-report.md'), c.report + '\n', 'utf8');
          } catch (err) {
            counters.writeFailures += 1; // R3
            log(`[sentinel] claude-report.md write failed (${pack.app_id}): ${err.message}`);
          }
          claudeText = c.report;
        } else {
          counters.claudeSkipped += 1; // R3
          log(`[sentinel] claude report skipped: ${c.reason}`);
        }
      }
      // 사람이 읽는 시나리오 제목을 앞세우고 시그니처는 보조로(수신자 관점)
      const what = pr.failedTitles?.[0] ?? pr.signatures[0] ?? '?';
      await notify(
        `[Sentinel] protected 실패: ${pack.app_id} — '${what}' (${pr.signatures[0] ?? '?'})\n증거: ${pr.refs[0] ?? '-'}` +
          (claudeText ? '\nclaude 보고 별도 발송' : ''),
        pr.screenshots[0] ? { photoPath: pr.screenshots[0] } : undefined
      );
      if (claudeText) {
        await notify(`[Sentinel] ${pack.app_id} claude 보고:\n${claudeText.slice(0, 3500)}`);
      }
    }
  }

  // §10 배칭: experimental 실패는 실행 종료 시 묶음 한 줄만 — 제목 우선, 시그니처는 보조
  if (experimentalFails.length) {
    await notify(
      `[Sentinel] experimental 실패 ${experimentalFails.length}건: ` +
        experimentalFails
          .map((p) => `${p.app_id} — '${p.failedTitles?.[0] ?? '?'}' (${p.signatures[0] ?? '?'})`)
          .join(', ')
    );
  }

  // R3 카운터를 원장에 남겨 §6 일일 다이제스트(Scribe)가 읽을 수 있게 한다 — 로그 파일은 소비 경로가 아니다
  await ledgerWrite({
    ts: nowISOKST(),
    source: 'sentinel',
    kind: 'note',
    title: 'sentinel run summary',
    detail:
      `packs_run=${counters.packsRun} skipped=${counters.packsSkipped} ` +
      `parse_failures=${counters.packParseFailures} write_failures=${counters.writeFailures} ` +
      `notify_failures=${counters.notifyFailures} claude_skipped=${counters.claudeSkipped}`,
  });

  log(
    `[sentinel] done packs_run=${counters.packsRun} R3: skipped=${counters.packsSkipped} ` +
      `pack_parse_failures=${counters.packParseFailures} write_failures=${counters.writeFailures} ` +
      `notify_failures=${counters.notifyFailures} claude_skipped=${counters.claudeSkipped}`
  );
  return { packs: results, order, counters, date };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadDotEnv, banner } = await import('../../boot/env.mjs');
  loadDotEnv();
  banner('sentinel');
  try {
    await runSentinel();
    process.exit(0); // 팩 실패는 원장·알림으로 보고된다 — cron에는 정상 종료
  } catch (err) {
    console.error(`[sentinel] engine crash: ${err?.stack ?? err}`);
    try {
      await sendNotify(`[Sentinel] 엔진 크래시: ${String(err).slice(0, 300)}`);
    } catch {
      // 크래시 알림조차 실패 — stderr에는 이미 남았다
    }
    process.exit(1);
  }
}
