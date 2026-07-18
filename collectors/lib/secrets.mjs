// 고정 프리픽스 패턴만 사용한다 — 엔트로피 휴리스틱은 40자 hex 커밋 SHA 오탐 위험으로 제외(DISCOVERY E.5).
const PATTERNS = [
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  // 이 시스템 자신이 보유한 시크릿 유형(§14)을 반드시 잡는다
  ['telegram-bot-token', /\b\d{8,10}:[A-Za-z0-9_-]{33,38}\b/],
  ['slack-webhook', /hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{30,}\b/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['sk-prefixed-key', /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ['slack-token', /\bxox[abps]-[A-Za-z0-9-]{10,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._/+=-]{30,}/],
];

// 시크릿 패턴이 발견되면 패턴 이름, 없으면 null.
export function findSecret(text) {
  if (!text) return null;
  for (const [name, re] of PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}
