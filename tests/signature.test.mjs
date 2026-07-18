import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorSignature } from '../qa-sentinel/lib/signature.mjs';

test('app_id:scope:slug 형식을 만든다 — 제목의 "scope: 설명" 규약', () => {
  const sig = errorSignature('fac_demo', 'result: 결과 화면 표시', 'smoke.spec.ts');
  assert.match(sig, /^fac_demo:result:[a-z0-9-]+$/);
});

test('제목에 scope 접두가 없으면 spec 파일명을 scope로 쓴다', () => {
  const sig = errorSignature('fac_demo', '페이지가 뜬다', 'smoke.spec.ts');
  assert.match(sig, /^fac_demo:smoke:[a-z0-9-]+$/);
});

test('같은 테스트는 항상 같은 시그니처 — 에러 메시지가 섞이지 않는다', () => {
  const a = errorSignature('fac_demo', 'result: 결과 화면 표시', 'smoke.spec.ts');
  const b = errorSignature('fac_demo', 'result: 결과 화면 표시', 'smoke.spec.ts');
  assert.equal(a, b);
});

test('slug는 소문자 케밥 — 공백·특수문자·대문자 정리', () => {
  const sig = errorSignature('fac_demo', 'Result: Blank Screen!! (v2)', 'smoke.spec.ts');
  const slug = sig.split(':')[2];
  assert.match(slug, /^[a-z0-9-]+$/);
  assert.ok(!slug.includes('--'));
});
