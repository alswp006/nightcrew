// §8 deadman — 위성(기기 무관, v2.4)에서 08:00 실행. 백업된 "오늘(KST)" 원장에 heartbeat/run_*가 없으면 알림.
// 오늘 파일 부재는 rsync 실패 또는 데스크톱 다운 — 두 경우 모두 당일 08:00에 잡힌다.
// 자기 생존 마커: 감시견 자신이 오래 돌지 않았던 것도 다음 실행이 알아챈다.
import path from 'node:path';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { todayKST, nowISOKST } from '../collectors/lib/kst.mjs';
import { expandHome } from '../collectors/lib/paths.mjs';
import { sendNotify } from '../notify/notify.mjs';

const WATCHDOG_GAP_MS = 26 * 3600 * 1000; // 하루 주기 + 여유

export async function runDeadman({
  backupLedgerDir = expandHome(process.env.NC_BACKUP_LEDGER_DIR ?? '~/nightcrew-backup/ledger'),
  markerPath,
  env = process.env,
  notifyImpl,
  now = new Date(),
  log = console.log,
} = {}) {
  const notify = notifyImpl ?? ((text) => sendNotify(text, { env }));
  backupLedgerDir = expandHome(backupLedgerDir);
  markerPath = expandHome(markerPath) ?? path.join(path.dirname(backupLedgerDir), 'deadman-marker.json');

  const today = todayKST(now);
  const file = path.join(backupLedgerDir, `${today}.jsonl`);
  let healthy = false;
  let reason = '';
  try {
    const text = await readFile(file, 'utf8');
    healthy = text
      .split('\n')
      .filter((l) => l.trim())
      .some((l) => {
        try {
          const e = JSON.parse(l);
          return e.kind === 'heartbeat' || /^run_/.test(e.kind ?? '');
        } catch {
          return false;
        }
      });
    if (!healthy)
      reason = `오늘(${today}) 백업 원장에 heartbeat/run_* 이벤트가 없다 — 가능 원인: ① 04:30 Sentinel 미실행(cron·PATH) ② 데스크톱 다운 후 재기동`;
  } catch {
    reason = `오늘(${today}) 원장 백업 파일이 없다 — 가능 원인: ① 07:30 rsync 실패(ssh·네트워크) ② 데스크톱 다운 ③ 04:30 Sentinel 미실행(cron·PATH)으로 오늘 파일 미생성`;
  }

  let watchdogGapWarned = false;
  try {
    const prev = JSON.parse(await readFile(markerPath, 'utf8'));
    if (prev?.lastRunAt && now.getTime() - new Date(prev.lastRunAt).getTime() > WATCHDOG_GAP_MS) {
      watchdogGapWarned = true;
    }
  } catch {
    // 마커 부재(첫 실행)·손상 — 공백 판정 불가, 이번 실행부터 새로 남긴다
  }

  const messages = [];
  if (!healthy) messages.push(`[Watchdog] deadman: ${reason}`);
  if (watchdogGapWarned) {
    messages.push('[Watchdog] 감시견 자신이 26시간 넘게 돌지 않았다 — 위성 기기 cron/전원 확인 필요');
  }
  let notifyFailures = 0;
  for (const m of messages) {
    try {
      const n = await notify(m);
      if (!n?.ok) notifyFailures += 1; // R3
    } catch {
      notifyFailures += 1;
    }
  }

  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(`${markerPath}.tmp`, JSON.stringify({ lastRunAt: now.toISOString(), lastRunKST: nowISOKST(now), healthy }) + '\n', 'utf8');
  await rename(`${markerPath}.tmp`, markerPath);

  log(`[deadman] today=${today} healthy=${healthy} gap_warned=${watchdogGapWarned} notify_failures=${notifyFailures}`);
  return { healthy, alerted: !healthy, watchdogGapWarned, notifyFailures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadDotEnv, banner } = await import('../boot/env.mjs');
  loadDotEnv();
  banner('deadman');
  const r = await runDeadman();
  process.exit(r.healthy ? 0 : 1);
}
