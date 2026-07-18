// §9.3 Sentinel-iOS — 결과를 계약 A 이벤트로 조립한다. 시그니처는 §4 규약(안정 슬러그, 원문 금지).
// CLI: node compose-event.mjs <appId> <pass|fail> [failedTestsCSV] [xcresultPath] → 이벤트 JSON을 stdout으로.
import { pathToFileURL } from 'node:url';
import { nowISOKST } from '../../collectors/lib/kst.mjs';

function camelToKebab(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

// 'LoginFlowTests.testMainScreenLoads' → scope 'login-flow-tests', slug 'main-screen-loads'
function iosSignature(appId, failedTest) {
  const [cls, method = ''] = String(failedTest).split('.');
  const scope = camelToKebab(cls) || 'ios';
  const slug = camelToKebab(method.replace(/^test/, '')) || 'failed';
  return `${appId}:${scope}:${slug}`;
}

export function composeIosEvent({ appId = 'love_place', passed, failedTests = [], xcresultPath, now = new Date() }) {
  const base = {
    ts: nowISOKST(now),
    source: 'sentinel',
    app: appId,
    kind: passed ? 'run_pass' : 'run_fail',
    title: passed ? `${appId} iOS 통과` : `${appId} iOS 실패 ${failedTests.length || '?'}건`,
  };
  if (!passed && failedTests.length) {
    base.detail = `error_signature=${iosSignature(appId, failedTests[0])}`;
  }
  if (xcresultPath) base.refs = [xcresultPath];
  return base;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [appId, result, failedCsv = '', xcresultPath] = process.argv.slice(2);
  const event = composeIosEvent({
    appId: appId || 'love_place',
    passed: result === 'pass',
    failedTests: failedCsv.split(',').map((s) => s.trim()).filter(Boolean),
    xcresultPath: xcresultPath || undefined,
  });
  process.stdout.write(JSON.stringify(event) + '\n');
}
