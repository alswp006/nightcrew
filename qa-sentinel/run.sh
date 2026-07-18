#!/usr/bin/env bash
# Sentinel 04:30 KST 엔트리 (§5). crontab 예: 30 4 * * * bash ~/nightcrew/qa-sentinel/run.sh >> ~/nightcrew/sentinel.log 2>&1
cd "$(dirname "$0")/.." || exit 1
exec node qa-sentinel/lib/engine.mjs "$@"
