// §4 계약 C: error_signature = app_id:scope:slug. Sentinel만 생성한다.
// scope는 테스트 제목의 "scope: 설명" 규약에서, 없으면 spec 파일명에서 온다.
// slug는 테스트 제목(정적 텍스트)에서만 만든다 — 에러 메시지는 절대 섞지 않는다(변동성 차단).

function hashCode(s) {
  let h = 5381;
  for (const c of s) h = ((h * 33) ^ c.codePointAt(0)) >>> 0;
  return h;
}

function slugify(s) {
  const ascii = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  // 비ASCII 제목(한국어 등)은 케밥화하면 빈 문자열이 되므로 제목 해시로 안정 슬러그를 만든다
  return ascii || 't' + hashCode(s).toString(36);
}

export function errorSignature(appId, testTitle, specFile) {
  const title = String(testTitle || '').trim();
  const m = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(title);
  const scope = m ? slugify(m[1]) : slugify(specFile.replace(/\.spec\.[a-z]+$/i, ''));
  const rest = m ? m[2] : title;
  return `${appId}:${scope}:${slugify(rest)}`;
}
