# nightcrew

야간조(Night Crew) — 밤새 앱을 실사용해보는 QA 봇(Sentinel), 이벤트 원장(Ledger), 기록 작가(Scribe), 감시견(Watchdog).
설계 원본은 **NIGHTCREW_DESIGN.md**(단일 진실), 구현 결정 사항은 **NIGHTCREW_DISCOVERY.md**.

## 구조

```
boot/env.mjs              R1 env 부트 + R2 기동 배너
collectors/ledger-append  계약 A 단일 관문 (검증·시크릿 스캔·동시 쓰기 안전)
collectors/ledger-read    계약 A 읽기 + 소비자 커서 (§2.4 멱등 소비)
notify/notify.mjs         계약 D (Telegram 기본, Slack 보조, 미설정 시 콘솔 폴백)
qa-sentinel/              Sentinel 엔진 + 앱 팩 (계약 B·C)
scribe/                   커밋 수집기 + 개발일지 작가 + 아침 스탠드업 (§6)
watchdog/                 M1 백업 pull + deadman (§8)
```

런타임 디렉터리(gitignore): `ledger/` `artifacts/` `store/` `journal/`

## 빠른 시작

```bash
npm install && npx playwright install chromium
cp .env.example .env   # LEDGER_DIR 등 채우기 (§14)
npm test               # 전체 테스트
```

### 원장에 이벤트 쓰기 (§2)

```bash
echo '{"ts":"2026-07-18T04:30:00+09:00","source":"test","kind":"note","title":"hi"}' \
  | node collectors/ledger-append.mjs
```

- 하루 한 파일 `$LEDGER_DIR/YYYY-MM-DD.jsonl` (**KST 경계**), append 전용
- 필수 `ts/source/kind`, 이벤트 ≤8KB, title·detail에 시크릿 패턴 발견 시 거부(exit 2)
- `LEDGER_DIR` 미설정 → 경고 1줄 + exit 0 (본 작업을 막지 않는다)

### Sentinel 수동 실행 (§5)

```bash
# Q1(실제 fac_* 앱) 확정 전 데모: 픽스처 서버로 검증
node qa-sentinel/apps/fac_demo/fixtures/server.mjs &
FAC_DEMO_BASE_URL=http://127.0.0.1:4173 bash qa-sentinel/run.sh
```

- 시작 시 `heartbeat`, 팩당 `run_pass`/`run_flaky`/`run_fail` 1건을 원장에 기록
- 실패 시 `detail`에 `error_signature=app_id:scope:slug`(§4), `refs`에 스크린샷·리포트 경로
- experimental 실패 → `heal_request` 발행 + 묶음 한 줄 알림 / protected 실패 → 즉시 알림(2연속 실패면 claude 보고 첨부)
- 새 앱 추가 = `qa-sentinel/apps/{app_id}/`에 `pack.json` + `scenarios/*.spec.ts` (§3). 폴더명 = app_id
- run_flaky 판정: Playwright retries=1, 팩 단위 집계(재시도로만 전부 통과 = flaky)

### 시나리오 규약

테스트 제목 `"scope: 설명"`의 scope가 error_signature의 scope가 된다. 에러 메시지는 시그니처에 절대 넣지 않는다(§4).

### Scribe 수동 실행 (§6)

```bash
npm run scribe:commits   # REPOS 화이트리스트의 커밋 → commit_digest 적립 (cron 23:50)
npm run scribe:daily     # 원장 → journal/오늘.md + 아침 스탠드업 1줄 (cron 07:00)
```

## 데스크톱(WSL2) 배치

```bash
# ⚠ `crontab <파일>`은 기존 crontab을 통째로 교체한다 — 반드시 병합형으로:
(crontab -l 2>/dev/null; cat deploy/desktop.crontab.example) | crontab -
```

WSL2 사전 조건: `/etc/wsl.conf`에 `[boot] systemd=true`(cron 가동), Windows 절전/재부팅 정책 확인 — NIGHTCREW_DISCOVERY.md Q6.
보존 정책(§2.5): 원장 jsonl 무기한, `artifacts/`는 30일 후 삭제(crontab의 09:00 정리 job — M1 백업이 별도 보존).

## M1(감시견) 배치 (§8)

1. 리포를 M1 `~/nightcrew`에 클론, `npm install` (Playwright 불필요 — 감시견은 브라우저를 안 쓴다)
2. `.env` 생성: **`SLACK_WEBHOOK_URL` 필수**(기본 채널, v2.2) — 없으면 deadman 알림이 로그 파일에만 남아 감시견이 무의미하다. 호스트/경로가 기본값과 다르면 `NC_DESKTOP_*`도 설정(.env.example 참조)
3. ssh 사전 검증 — cron 비대화형 환경 그대로 재현해 통과해야 한다(passphrase 없는 키 + tailnet):
   `env -i HOME="$HOME" PATH=/usr/bin:/bin ssh desktop true && echo OK`
   보안 권장: M1용 키는 데스크톱 `authorized_keys`에서 `command="rrsync -ro ~/nightcrew",restrict`로 읽기 전용 제한(§8 단방향 pull 강제)
4. macOS 절전 해제(잠자면 cron이 안 돈다): `sudo pmset -a sleep 0` 또는 07:20~08:10 예약 깨우기
5. crontab 병합 등록: `(crontab -l 2>/dev/null; cat deploy/m1.crontab.example) | crontab -`
6. 검증(§13-2): `bash watchdog/backup.sh` 수동 1회 → rsync 성공 확인 / `NC_BACKUP_LEDGER_DIR=/tmp/empty node watchdog/deadman.mjs` → 알림 발화 확인

## env (§14)

`.env.example` 참조. 전부 선택 — 미설정이면 해당 기능만 건너뛰고 카운트한다(R3).

## 배포 시 검증 잔여 체크리스트

로컬(macOS)에서 §13 완성 기준은 전부 실검증됐다. 실제 배포에서만 확인 가능한 잔여 항목은 NIGHTCREW_DISCOVERY.md §G 참조.
