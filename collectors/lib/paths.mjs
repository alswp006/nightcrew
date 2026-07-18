import os from 'node:os';
import path from 'node:path';

// §14 기본값 "~/nightcrew/ledger" 같은 ~ 경로를 지원한다 — 미확장 시 cwd 아래 '~' 디렉터리가 조용히 생기는 사고 방지.
export function expandHome(p, home = os.homedir()) {
  if (!p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}
