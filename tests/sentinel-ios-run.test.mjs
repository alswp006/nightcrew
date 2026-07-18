import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const RUN_SH = new URL('../sentinel-ios/run.sh', import.meta.url).pathname;

// xcodebuild·ssh를 스텁으로 바꿔 run.sh의 판정·적립 경로를 실제 실행한다.
// (실패가 pass로 기록되던 pipefail 회귀를 고정하는 테스트)
async function setupStubs({ xcodebuildExit, xcodebuildOut }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nc-ios-'));
  const capture = path.join(dir, 'captured.json');
  await writeFile(path.join(dir, 'xcodebuild'), `#!/bin/sh\nprintf '%s\\n' "${xcodebuildOut}"\nexit ${xcodebuildExit}\n`);
  await writeFile(path.join(dir, 'ssh'), `#!/bin/sh\ncat > "${capture}"\n`);
  await chmod(path.join(dir, 'xcodebuild'), 0o755);
  await chmod(path.join(dir, 'ssh'), 0o755);
  return { dir, capture };
}

function runScript(stubDir, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [RUN_SH],
      {
        env: {
          ...process.env,
          PATH: `${stubDir}:${process.env.PATH}`,
          NC_IOS_PROJECT: '/tmp/demo.xcodeproj',
          NC_IOS_SCHEME: 'Demo',
          ...extraEnv,
        },
      },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })
    );
  });
}

test('xcodebuild 실패는 run_fail + §4 시그니처로 적립된다 (pipefail 회귀 방지)', async () => {
  const { dir, capture } = await setupStubs({
    xcodebuildExit: 65,
    xcodebuildOut: "Test Case '-[HomeTests testFeedVisible]' failed",
  });
  const r = await runScript(dir);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const event = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(event.kind, 'run_fail', '실패가 pass로 둔갑하면 iOS 트랙 전체가 침묵 실패한다');
  assert.match(event.detail, /^error_signature=love_place:home-tests:feed-visible$/);
});

test('xcodebuild 성공은 run_pass로 적립된다', async () => {
  const { dir, capture } = await setupStubs({ xcodebuildExit: 0, xcodebuildOut: 'Test Suite passed' });
  const r = await runScript(dir);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const event = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(event.kind, 'run_pass');
});
