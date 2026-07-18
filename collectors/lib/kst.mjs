// KST는 DST가 없으므로 고정 +09:00 산술로 계산한다 — 시스템 TZ에 의존하지 않는다(§2.1 KST 날짜 경계).
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');

export function nowISOKST(now = new Date()) {
  const t = new Date(now.getTime() + KST_OFFSET_MS);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+09:00`
  );
}

export function todayKST(now = new Date()) {
  return nowISOKST(now).slice(0, 10);
}
