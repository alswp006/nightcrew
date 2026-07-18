import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../collectors/lib/schema.mjs';

const base = { ts: '2026-07-18T03:12:44+09:00', source: 'test', kind: 'note', title: 'hi' };

test('필수 필드(ts/source/kind)가 있으면 통과한다', () => {
  const r = validateEvent(base);
  assert.equal(r.ok, true);
});

test('필수 필드가 빠지면 어떤 필드인지 밝히며 거부한다', () => {
  for (const missing of ['ts', 'source', 'kind']) {
    const e = { ...base };
    delete e[missing];
    const r = validateEvent(e);
    assert.equal(r.ok, false);
    assert.match(r.reason, new RegExp(missing));
  }
});

test('ts가 ISO8601이 아니면 거부한다', () => {
  const r = validateEvent({ ...base, ts: 'yesterday' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ts/);
});

test('직렬화 8KB 초과 이벤트는 거부한다', () => {
  const r = validateEvent({ ...base, detail: 'x'.repeat(9000) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /8KB|8192|size/i);
});

test('8KB 경계: 정확히 8192B는 통과, 8193B는 거부', () => {
  const skeleton = { ...base, detail: '' };
  const overhead = Buffer.byteLength(JSON.stringify(skeleton), 'utf8');
  const exact = { ...base, detail: 'x'.repeat(8192 - overhead) };
  assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), 8192);
  assert.equal(validateEvent(exact).ok, true);
  const over = { ...base, detail: 'x'.repeat(8193 - overhead) };
  assert.equal(validateEvent(over).ok, false);
});

test('8KB는 문자 수가 아니라 바이트 기준 — 한국어 detail도 정확히 잰다', () => {
  // 한글 1자 = UTF-8 3B. 문자 수는 3천이지만 바이트는 9천 → 거부되어야 한다
  const r = validateEvent({ ...base, detail: '가'.repeat(3000) });
  assert.equal(r.ok, false);
});

test('kind는 권장 어휘 밖 문자열도 허용한다 (additive 원칙)', () => {
  const r = validateEvent({ ...base, kind: 'custom_future_kind' });
  assert.equal(r.ok, true);
});

test('JSON 객체가 아니면 거부한다', () => {
  for (const bad of [null, [], 'str', 42]) {
    assert.equal(validateEvent(bad).ok, false);
  }
});
