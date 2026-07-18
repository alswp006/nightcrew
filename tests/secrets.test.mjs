import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSecret } from '../collectors/lib/secrets.mjs';

// 픽스처는 전부 가짜지만 GitHub push protection이 실제 시크릿으로 오인하지 않게
// 소스 텍스트에서는 프리픽스와 본문을 분리해 조립한다 (런타임 값은 온전한 패턴).
const join = (...parts) => parts.join('');

test('알려진 토큰 프리픽스를 잡는다', () => {
  const positives = [
    'key AKIAIOSFODNN7EXAMPLE leaked',
    join('token ghp', '_16C7e42F292c6912E7710c838347Ae178B4a'),
    join('github_pat', '_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDE0123456789abcdefghij'),
    'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
    join('xoxb', '-1234567890-abcdefghijklmnop'),
    'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.dQw4w9WgXcQ',
    '-----BEGIN RSA PRIVATE KEY-----',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD',
  ];
  for (const text of positives) {
    assert.notEqual(findSecret(text), null, `미탐: ${text.slice(0, 30)}`);
  }
});

test('자체 보유 시크릿 유형(Telegram 토큰·Slack 웹훅)과 주요 변형을 잡는다', () => {
  const positives = [
    join('bot 123456789', ':AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'),
    join('https://hooks.slack.com/', 'services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX'),
    join('gho', '_16C7e42F292c6912E7710c838347Ae178B4a'),
    join('ghs', '_16C7e42F292c6912E7710c838347Ae178B4a'),
    'key AIzaSyA-1234567890abcdefghijklmnopqrstu',
    join('npm', '_abcdefghijklmnopqrstuvwxyz0123456789'),
  ];
  for (const text of positives) {
    assert.notEqual(findSecret(text), null, `미탐: ${text.slice(0, 30)}`);
  }
});

test('40자 hex 커밋 SHA는 오탐하지 않는다', () => {
  assert.equal(findSecret('commit dadbf54c1e2a9b8f7d6e5c4b3a2910fedcba9876'), null);
});

test('일상 텍스트는 오탐하지 않는다', () => {
  const negatives = [
    '결과 화면 미표시',
    'error_signature=fac_demo:result:blank-screen',
    '3 commits to nightcrew: feat ledger-append',
    'skipped=2 parse_failures=0',
  ];
  for (const text of negatives) {
    assert.equal(findSecret(text), null, `오탐: ${text}`);
  }
});

test('빈 값과 undefined는 통과한다', () => {
  assert.equal(findSecret(''), null);
  assert.equal(findSecret(undefined), null);
});
