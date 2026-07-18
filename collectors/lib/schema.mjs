const MAX_BYTES = 8192;
const REQUIRED = ['ts', 'source', 'kind'];

// §2.2: kind는 권장 어휘 밖도 허용한다(additive 원칙) — 필수 필드·크기·ts 형식만 강제.
export function validateEvent(event) {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return { ok: false, reason: 'event must be a JSON object' };
  }
  for (const field of REQUIRED) {
    if (typeof event[field] !== 'string' || event[field].length === 0) {
      return { ok: false, reason: `missing required field: ${field}` };
    }
  }
  if (Number.isNaN(Date.parse(event.ts))) {
    return { ok: false, reason: 'ts must be ISO8601' };
  }
  const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
  if (bytes > MAX_BYTES) {
    return { ok: false, reason: `event size ${bytes}B exceeds 8KB limit (${MAX_BYTES}B)` };
  }
  return { ok: true };
}
