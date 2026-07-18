import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeIosEvent } from '../sentinel-ios/lib/compose-event.mjs';

test('성공 실행은 run_pass 이벤트를 만든다', () => {
  const e = composeIosEvent({ appId: 'love_place', passed: true, now: new Date('2026-07-17T21:00:00Z') });
  assert.equal(e.kind, 'run_pass');
  assert.equal(e.source, 'sentinel');
  assert.equal(e.app, 'love_place');
  assert.match(e.ts, /\+09:00$/);
});

test('실패 실행은 run_fail + §4 시그니처(love_place:ios-scope:slug)를 만든다', () => {
  const e = composeIosEvent({
    appId: 'love_place',
    passed: false,
    failedTests: ['LoginFlowTests.testMainScreenLoads'],
    xcresultPath: 'artifacts/love_place/2026-07-18/test.xcresult',
  });
  assert.equal(e.kind, 'run_fail');
  assert.match(e.detail, /^error_signature=love_place:[a-z0-9-]+:[a-z0-9-]+$/);
  assert.ok(!e.detail.includes('Tests.test'), '시그니처는 케밥 슬러그 — 원문 그대로 넣지 않는다');
  assert.deepEqual(e.refs, ['artifacts/love_place/2026-07-18/test.xcresult']);
});

test('같은 실패는 항상 같은 시그니처 (§4 안정성)', () => {
  const a = composeIosEvent({ appId: 'love_place', passed: false, failedTests: ['HomeTests.testFeedVisible'] });
  const b = composeIosEvent({ appId: 'love_place', passed: false, failedTests: ['HomeTests.testFeedVisible'] });
  assert.equal(a.detail, b.detail);
});
