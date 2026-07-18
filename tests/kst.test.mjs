import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayKST, nowISOKST } from '../collectors/lib/kst.mjs';

test('todayKST: UTC 자정 직전(KST 아침)은 KST 날짜를 반환한다', () => {
  // 2026-07-17T23:30Z = 2026-07-18T08:30+09:00 — 시스템의 활동 창이 정확히 이 구간
  assert.equal(todayKST(new Date('2026-07-17T23:30:00Z')), '2026-07-18');
});

test('todayKST: KST 자정 직전은 전날로 남는다', () => {
  // 2026-07-18T14:59Z = 2026-07-18T23:59+09:00
  assert.equal(todayKST(new Date('2026-07-18T14:59:00Z')), '2026-07-18');
  // 2026-07-18T15:00Z = 2026-07-19T00:00+09:00
  assert.equal(todayKST(new Date('2026-07-18T15:00:00Z')), '2026-07-19');
});

test('nowISOKST: +09:00 오프셋의 ISO8601을 반환한다', () => {
  const s = nowISOKST(new Date('2026-07-17T19:12:44Z'));
  assert.equal(s, '2026-07-18T04:12:44+09:00');
});
