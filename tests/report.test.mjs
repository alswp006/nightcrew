import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSecondConsecutiveFail } from '../qa-sentinel/lib/report.mjs';

const e = (app, kind) => ({ event: { app, kind } });

test('직전 run_*이 run_fail이면 2연속 실패다', () => {
  assert.equal(isSecondConsecutiveFail([e('a', 'run_pass'), e('a', 'run_fail')], 'a'), true);
});

test('직전 run_*이 통과면 2연속이 아니다', () => {
  assert.equal(isSecondConsecutiveFail([e('a', 'run_fail'), e('a', 'run_pass')], 'a'), false);
});

test('기록이 없으면 첫 실패 — 2연속이 아니다', () => {
  assert.equal(isSecondConsecutiveFail([], 'a'), false);
});

test('다른 앱·run 이외 kind는 판정에 끼지 않는다', () => {
  const events = [e('a', 'run_fail'), e('b', 'run_pass'), e('a', 'heal_request')];
  assert.equal(isSecondConsecutiveFail(events, 'a'), true, 'heal_request는 무시하고 마지막 run_fail 기준');
  assert.equal(isSecondConsecutiveFail(events, 'b'), false);
});
