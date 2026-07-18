#!/usr/bin/env bash
# §9.3 Sentinel-iOS 골격 — M4(v2.3 위성)에서 실행. love_place 배포 후 상세 설계 전까지의 최소 러너.
# ⚠ Xcode 프로젝트가 있어야 동작하며 이 골격은 실기기 검증 전이다 — 시나리오(테스트 플랜)는 §9.3 설계 시 확정.
#
# 필요 env (M4 .env):
#   NC_IOS_PROJECT  .xcodeproj 또는 .xcworkspace 경로
#   NC_IOS_SCHEME   테스트 scheme
#   NC_IOS_DEST     기본 'platform=iOS Simulator,name=iPhone 15'
#   NC_DESKTOP_HOST 기본 desktop
#
# 결과 적립은 §2.3 예외 ② — ssh 경유 ledger-append 유틸 "1회"만. 원장에 직접 쓰지 않는다.
# pipefail 필수: 파이프의 종료 코드가 tee(항상 0)가 되면 실패가 영원히 pass로 기록된다.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
if [ -f .env ]; then set -a; . ./.env; set +a; fi

PROJECT="${NC_IOS_PROJECT:?NC_IOS_PROJECT가 필요하다}"
SCHEME="${NC_IOS_SCHEME:?NC_IOS_SCHEME가 필요하다}"
DEST="${NC_IOS_DEST:-platform=iOS Simulator,name=iPhone 15}"
HOST="${NC_DESKTOP_HOST:-desktop}"
APP_ID="${NC_IOS_APP_ID:-love_place}"

echo "[boot] component=sentinel-ios project=$PROJECT scheme=$SCHEME dest=$DEST"

case "$PROJECT" in
  *.xcworkspace) FLAG=-workspace ;;
  *) FLAG=-project ;;
esac

LOG=$(mktemp)
if xcodebuild test "$FLAG" "$PROJECT" -scheme "$SCHEME" -destination "$DEST" 2>&1 | tee "$LOG"; then
  RESULT=pass
  FAILED=""
else
  RESULT=fail
  # "Test Case '-[LoginFlowTests testMainScreenLoads]' failed" → LoginFlowTests.testMainScreenLoads
  FAILED=$(grep -o "Test Case '-\[[A-Za-z0-9_]* [A-Za-z0-9_]*\]' failed" "$LOG" \
    | sed "s/Test Case '-\[\([A-Za-z0-9_]*\) \([A-Za-z0-9_]*\)\]' failed/\1.\2/" \
    | paste -sd, -) || FAILED=""
fi
rm -f "$LOG"

# 이벤트 조립(로컬) → ssh 경유 관문 유틸 1회 (§2.3 예외 ②). 적립 실패는 침묵하지 않는다(R3).
if ! node sentinel-ios/lib/compose-event.mjs "$APP_ID" "$RESULT" "$FAILED" \
  | ssh "$HOST" "node nightcrew/collectors/ledger-append.mjs"; then
  echo "[sentinel-ios] 원장 적립 실패 (ssh 또는 관문 거부)" >&2
  exit 1
fi
