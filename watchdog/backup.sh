#!/usr/bin/env bash
# §8 감시견 백업 — M4(v2.3 위성)에서 07:30 단방향 pull (ledger + journal + artifacts).
# 전제: M4→데스크톱 ssh 도달(tailnet, DISCOVERY Q7).
set -u
cd "$(dirname "$0")/.." || exit 1

# R1: cron 셸에는 전역 export가 없다 — 리포 .env를 승격한다
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

HOST="${NC_DESKTOP_HOST:-desktop}"
SRC="${NC_DESKTOP_NIGHTCREW:-nightcrew}"        # 원격 홈 기준 경로
DEST="${NC_BACKUP_ROOT:-$HOME/nightcrew-backup}"
mkdir -p "$DEST"

# R2: 해석된 대상 1줄
echo "[boot] component=backup HOST=$HOST SRC=$SRC DEST=$DEST"

failed=""
for d in ledger journal artifacts; do
  if ! rsync -az "$HOST:$SRC/$d/" "$DEST/$d/"; then
    failed="$failed $d"
    echo "[backup] rsync failed: $d" >&2
  fi
done

# ledger 실패만 즉시 알림+exit 1 — journal/artifacts는 첫 배포 시 원격 부재로 흔해
# 매일 알림 소음을 만들지 않는다(치명 경로는 deadman의 "오늘 파일 부재" 검사가 이중으로 잡는다).
case "$failed" in
  *ledger*)
    node notify/notify.mjs "[Watchdog] 원장 백업 rsync 실패:$failed" || true
    exit 1
    ;;
esac

# 부분 실패(journal/artifacts)가 영구 침묵하지 않게 — 3일 연속이면 알림으로 승격 (R3)
WARN_MARKER="$DEST/.partial-fail-count"
if [ -n "$failed" ]; then
  count=$(($(cat "$WARN_MARKER" 2>/dev/null || echo 0) + 1))
  echo "$count" > "$WARN_MARKER"
  if [ "$count" -ge 3 ]; then
    node notify/notify.mjs "[Watchdog] 백업 부분 실패 ${count}일 연속:$failed — 원격 디렉터리/권한 확인 필요" || true
  fi
else
  echo 0 > "$WARN_MARKER"
fi
echo "[backup] done -> $DEST${failed:+ (warn:$failed)}"
exit 0
