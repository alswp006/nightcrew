# NIGHTCREW_DISCOVERY.md

> §0.2 프로토콜 산출물. 작성일 2026-07-18. 리포가 빈 리포이므로 §0.2 예외 조항에 따라 **"생성할 디렉터리 구조 + §13 1주차 체크리스트"**로 갈음하되, 설계 검토에서 확정된 문제·질문·채택 기본값을 함께 담는다.
> **§0.3에 따라 이 문서 제출 후 멈춘다. 사람이 "구현 승인"이라고 말하기 전에는 코드를 작성하지 않는다.**

---

## A. 자기 위치 파악 (§0.1)

- 판단 근거: 리포 이름 `nightcrew`(origin `alswp006/nightcrew`), 내용물은 README.md + NIGHTCREW_DESIGN.md뿐인 신규 빈 리포.
- 담당: **원장 유틸 + Sentinel 엔진/팩 + Scribe + notify** (§2~§8, §10, §11).
- 참고: 현재 클론 위치는 개발 머신(macOS) `~/Project/night-crew`. 운용 대상은 데스크톱 WSL2 `~/nightcrew` — 아래 질문 Q4 참조.

## B. 설계 문서 검토 결과 (다각도 검토 + 반박 검증 통과분만)

설계 v2.0은 전체적으로 견고하다 — 원장 중심 결합, profile 가드레일(§11), 실사고 승격 규칙(R1~R3), 검증 가능한 완성 기준(§13)까지 갖췄다. 아래는 반박 검증을 통과한 실제 결함/공백 15건이며, **구현 착수 전 문서 수정이 필요한 것**과 **구현 시 기본값으로 흡수 가능한 것**을 구분했다.

### B.1 문서 수정 제안 (승인 시 NIGHTCREW_DESIGN.md에 반영)

| # | 위치 | 문제 | 수정 제안 |
|---|---|---|---|
| 1 | §8 deadman | **[높음]** 08:00에 "어제 파일"을 검사하지만 heartbeat(04:30)는 KST 경계상 **오늘 파일**에 기록됨 → 지난밤 다운을 24시간 늦게 감지. rsync 실패 시에도 옛 파일로 검사 통과 | 검사 대상을 "**오늘(KST) 파일**"로 변경 — heartbeat 부재와 rsync 실패(파일 자체 부재) 모두 당일 08:00에 잡힘 |
| 2 | §2.5 ↔ §8 | **[높음]** §2.5는 artifacts 30일 삭제 근거로 "감시견 백업 별도 보존"을 전제하나 §8 백업 대상은 ledger·journal뿐 → 30일 후 refs 증거 영구 유실 | §8 rsync 대상에 `artifacts/` 추가, 또는 §2.5의 보존 문구 수정 |
| 3 | §7.2 | `apps/fac_{app_id}/` 표기는 app_id가 이미 fac_ 접두를 포함하므로(§3.2) 이중 접두(fac_fac_*)가 됨 | `apps/{app_id}/`로 정정(오탈자 처리). 1주차 엔진 폴더 규약은 **폴더명 = app_id 그대로**로 확정 |
| 4 | §1.2 R3, §2.4 | "일일 다이제스트(§8)" 상호참조 오류 — §8은 Watchdog 장. 다이제스트는 §6 Scribe에 정의됨 | 참조를 §6으로 정정 |
| 5 | §5 ↔ §7.3 | experimental 실패 1건이 `run_fail`+`heal_request` 두 이벤트로 적재되는데 §7.3 소비 필터가 "run_fail(또는 heal_request)"라 이중 티켓 위험(앱당 야간 2회 상한 헛소진) | Self-heal 티켓 소스를 **`heal_request` 단일 kind로 확정**(run_fail은 기록·통계용). 발행 측이 1주차 Sentinel이므로 지금 확정 필요 |
| 6 | §0.1 표 | 5대 구성요소 중 Watchdog만 담당 리포 미배정 | nightcrew 행 담당에 **Watchdog 스크립트(M1 배포)** 추가 — 코드는 nightcrew 리포 `watchdog/`에 두고 M1에서 pull |
| 7 | §1 mermaid | Scribe 산출물 "블로그 초안"이 본문(작가 3인)에 없음 | 다이어그램에서 제거하거나 SCRIBE_SPEC 후속 트랙으로 명시 |

### B.2 구현 기본값으로 흡수 (아래 E절에 채택안 명기, 승인 한 번으로 함께 확정)

- **KST 강제 메커니즘 부재** — 이 시스템의 활동 창(00:00~08:00 KST, v2.2)은 전부 UTC 날짜 ≠ KST 날짜 구간. `toISOString()`류 UTC 날짜 하나만 끼어도 매일 밤 오파일 → E.3 참조.
- **run_flaky 재시도 규약 미정** — E.4 참조.
- **시크릿 스캔 패턴 미정의** — E.5 참조.
- **refs·artifacts 기준 경로 암묵적**(~/nightcrew 가정) — E.6 + 질문 Q4 참조.

### B.3 환경 확인 필요 (구현 전 데스크톱에서 확인)

- **WSL2 cron 상시 동작 전제 미명세** — systemd/cron 옵트인 여부, VM 유휴 종료 방지, 기존 야간배치(v2.2부터 00:00)의 구동 메커니즘 확인 → 질문 Q6.
- **M1→WSL2 ssh/rsync 수신 경로 미정의** — WSL2 기본 NAT에서는 외부 머신이 직접 접속 불가. tailnet `desktop` 노드가 Windows 호스트인지 WSL2 게스트인지에 따라 §8 rsync·§2.3 예외② 경로가 갈림 → 질문 Q7 (2주차 전 확정이면 충분).
- **SCRIBE_SPEC.md 부재** — 2주차(Scribe Phase 1) 원본 명세. 1주차 비차단, 2주차 전 소재 확인 → 질문 Q8.

### B.4 검토했으나 기각된 우려 (기록용)

flock 이식성(원장 쓰기는 WSL2 한정이라 무관), notify 배칭 주체(§5가 이미 엔진으로 귀속), run.sh 실행 방식(의도된 구현 여백), BUILD_PLAN 부재(보조 런북으로 격하됨, §14가 자족적), 실행당 이벤트 1건 규칙 위반(오독 — heartbeat도 별도 append됨) 등 11건은 반박 검증에서 기각.

---

## C. 생성할 디렉터리 구조 (§0.2 예외 ①)

```
nightcrew/                          # 데스크톱(WSL2)에서는 ~/nightcrew 체크아웃 가정 (Q4)
├── README.md
├── NIGHTCREW_DESIGN.md             # 단일 진실 (기존)
├── NIGHTCREW_DISCOVERY.md          # 본 문서
├── package.json                    # 단일 패키지, "type":"module", Node 20+, @playwright/test
├── .env.example                    # §14 표의 값 전부 빈칸으로 명시
├── .gitignore                      # .env, ledger/, artifacts/, store/, journal/
├── boot/
│   └── env.mjs                     # R1: dotenv 부트(모든 엔트리의 첫 import) + R2: 기동 배너 헬퍼
├── collectors/                     # §2.3 지정 위치
│   ├── ledger-append.mjs           # 단일 관문: 검증·flock·시크릿 스캔 (CLI + import 겸용)
│   ├── ledger-read.mjs             # §2.4 읽기 + 파싱 실패 카운트(R3). 커서 관리는 2주차 소비자 몫
│   └── lib/
│       ├── schema.mjs              # ts/source/kind 필수·≤8KB·kind 어휘 검증
│       └── secrets.mjs             # 시크릿 정규식 스캐너 (E.5 패턴 세트)
├── notify/
│   └── notify.mjs                  # §10 계약 D: 무상태 단건 발송, env 채널 선택, 콘솔 폴백
├── qa-sentinel/                    # §3.1 구조 그대로
│   ├── run.sh                      # 04:30 KST cron 엔트리 — heartbeat → 팩 순회 → 배칭 알림 flush
│   ├── lib/
│   │   ├── engine.mjs              # 팩 발견·격리 실행·protected→experimental 순서·스킵 카운트(R3)
│   │   ├── signature.mjs           # §4 error_signature 생성 (Sentinel 전용)
│   │   └── report.mjs              # result.json·원장 append·§11 profile별 알림 라우팅
│   └── apps/
│       └── {app_id}/               # 폴더명 = app_id 그대로 (B.1 #3). Q1 확정 후 생성
│           ├── pack.json           # §3.2 규약 (1주차 손팩은 created_by=human)
│           ├── scenarios/smoke.spec.ts
│           └── fixtures/
├── watchdog/                       # §8 스크립트 (M1에서 pull해 cron 등록 — B.1 #6) — 2주차
├── scribe/                         # 2주차 자리 예약
├── store/                          # 런타임(gitignore): cursors/ inbox/
├── ledger/                         # $LEDGER_DIR 기본값 — YYYY-MM-DD.jsonl (KST, append 전용)
├── artifacts/                      # §3.3 증거 (30일 보존)
└── journal/                        # 2주차 Scribe 출력
```

## D. 1주차 체크리스트 (§0.2 예외 ② — §13 완성 기준 매핑)

1. **리포 뼈대** — package.json(ESM)·boot/env.mjs(R1)·.env.example·.gitignore.
   ✅ 아무 엔트리든 실행 시 R2 배너 1줄: 해석된 LEDGER_DIR 절대경로 + 알림 채널 + **TZ/오늘(KST) 날짜**(E.3).
2. **ledger-append** — 필수 필드 검증, ≤8KB, 시크릿 거부, flock append.
   ✅ §13 그대로: `echo '{"ts":"...","source":"test","kind":"note","title":"hi"}' | node collectors/ledger-append.mjs` → 오늘(KST) 파일에 정확히 1줄.
3. **ledger-append 실패 모드** —
   ✅ LEDGER_DIR 언셋 → 경고 1줄 + exit 0. ✅ detail에 가짜 토큰 → 거부 + 원장 미기록 + 거부 카운트(R3).
4. **ledger-read** — 파싱 실패 줄 스킵+카운트 반환(R3).
   ✅ 깨진 줄 섞인 테스트 jsonl에서 카운트 정확, 정상 줄 전량 반환.
5. **notify** — env 채널 선택, 무상태 단건 발송, 실패 시 본 작업 계속+카운트.
   ✅ §13 그대로: 채널 전부 미설정 상태 호출 → 콘솔 폴백 + exit 0.
6. **Sentinel 엔진** — 팩 발견·격리·순서·스킵 카운트·heartbeat·배칭 알림.
   ✅ pack.json 없는 폴더 무시 / base_url 미설정 팩 스킵+카운트 / 시작 시 heartbeat 1건 append / 한 팩 실패가 다음 팩을 막지 않음 / experimental 실패는 종료 시 묶음 한 줄(§10).
7. **첫 팩 작성** (Q1 확정 필요) — §3.2 규약, profile=experimental, level=smoke, created_by=human(3주차 Factory 재산출 시 factory로 교체).
   Q1 답변 전에는 더미 정적 페이지 팩으로 엔진 골격만 검증(§3.3 스킵 규약과 정합).
8. **통합 수동 1회** —
   ✅ §13 그대로: run.sh 수동 1회 → 원장 `run_*` 1건 + error_signature가 `app_id:scope:slug` 형식(§4) + `artifacts/{app_id}/{오늘}/` + app_id 포함 result.json.
9. **데스크톱 04:30 KST 스케줄 등록** (Q6 답변에 따라 cron 또는 systemd timer) —
   ✅ 다음 날 아침 원장에 자동 heartbeat 1건. R3 카운터(스킵·파싱 실패·쓰기 실패)를 stdout과 result.json에 노출해 2주차 다이제스트(§6)가 읽게 함.

## E. 채택 기본값 (승인 시 함께 확정 — 물을 필요 없는 결정)

1. **패키지**: 리포 루트 단일 npm 패키지, ESM("type":"module"), Node 20 LTS. 유틸은 의존성 최소 .mjs, 시나리오는 @playwright/test가 자체 처리하는 .spec.ts(빌드용 tsconfig 불필요).
2. **notify 역할 분리**: notify는 무상태 단건 발송만. 배칭은 "실행 종료" 시점을 아는 Sentinel 엔진이 집계 후 1회 호출(§5·§10 정합).
3. **KST 강제**: 모든 날짜 계산은 공용 헬퍼(`Asia/Seoul` 명시) 경유 — 시스템 TZ 불신. R2 배너에 해석된 TZ와 오늘(KST) 날짜 출력.
4. **run_flaky 규약**: Playwright retries=1(smoke). 팩 단위 집계 — 전 테스트 1차 통과=`run_pass`, 재시도로 전부 통과=`run_flaky`, 재시도 후에도 실패 잔존=`run_fail`. 엔진 README에 명기.
5. **시크릿 스캔 초기 패턴**: 고정 프리픽스 위주 — `AKIA[0-9A-Z]{16}`, `ghp_`/`github_pat_`, `sk-`, `xox[abp]-`, JWT(`eyJ`~), `-----BEGIN … PRIVATE KEY-----`, `Bearer <장문토큰>`. 엔트로피 휴리스틱은 오탐 위험으로 제외(40자 hex 커밋 SHA 오탐 방지). 거부 시 사유 stderr + 거부 카운트(R3).
6. **경로 기준점**: refs·artifacts 상대경로의 기준 = 리포 루트(운용 시 `~/nightcrew`). Q4에서 확인.

## F. 사람에게 물을 질문 (§0.2 ④·⑤)

- **Q1 (§14 결정①, 1주차 차단)**: 첫 팩으로 쓸 fac_* 앱은? 그 배포 URL(`FAC_*_BASE_URL` 값)은? smoke에서 도달 확인할 핵심 화면 1~2개는?
- **Q2 (§14 결정②)**: love_place 웹 URL이 존재하는가? (있으면 protected 웹 팩 추가 — 3주차 전까지만 답하면 됨)
- **Q3 (§14 결정③)**: 전체 야간 힐 상한 M은 기본 4 유지? (3주차 값)
- **Q4**: 데스크톱에서 이 리포의 체크아웃 경로는 `~/nightcrew`가 맞는가? (§7.2 설치 경로·§8 rsync 경로·refs 기준점과 정합해야 함)
- **Q5**: `TELEGRAM_TOKEN`/`TELEGRAM_CHAT_ID` 발급값은? `SLACK_WEBHOOK_URL` 병행?
- **Q6**: 데스크톱 04:30 실행 방식 — WSL2 내부 cron/systemd timer인가, Windows 작업 스케줄러인가? 기존 야간배치(v2.2부터 scout 23:00·nightly 00:00 — ai-factory NIGHTLY_SETUP.md crontab)는 어느 메커니즘으로 도는가?
- **Q7 (2주차 전)**: tailnet의 `desktop` 노드는 Windows 호스트인가 WSL2 게스트인가? (M4 rsync·ssh append 경로 결정 — v2.3: 위성 = M4)
- **Q8 (2주차 전)**: SCRIBE_SPEC.md의 소재는? (타 리포 존재? 미작성?)
- **Q9**: B.1의 문서 수정 제안 7건을 NIGHTCREW_DESIGN.md에 반영해도 되는가?

## G. 배포 시 검증 잔여 체크리스트 (1~2주차 구현 완료 후 갱신, 2026-07-18)

로컬(macOS)에서 §13 1·2주차 완성 기준은 전부 실검증 완료(테스트 + 실제 명령). 실제 배포에서만 확인 가능한 잔여:

| # | 항목 | §13 기준 | 차단 질문 | 검증 방법 |
|---|---|---|---|---|
| 1 | 데스크톱 04:30 cron 등록 후 다음 날 heartbeat 자동 적재 | 1주차 D.9 | Q6 | 다음 날 아침 원장 grep heartbeat |
| 2 | 실제 fac_* 앱 팩으로 Sentinel 1회 (지금은 fac_demo 더미) | 1주차 D.7~8 | **Q1** | 팩 교체 후 run.sh 수동 1회 |
| 3 | M4→데스크톱 rsync 실제 성공 | 2주차 | Q7 | README M4 배치 절 3·6단계 |
| 4 | M4 deadman cron 첫 자동 발화 (PATH·절전·mkdir 함정은 문서화됨) | 2주차 | Q7 | 다음 날 08:00 로그·알림 확인 |
| 5 | Telegram 실발송 (지금까지는 콘솔 폴백만 검증) | 1주차 D.5 | Q5 | 토큰 설정 후 notify CLI 1회 |
| 6 | §5 "파이프라인 진행 중 팩 스킵" — Factory 마커 필요 | — | 3주차 이월 | §7 훅과 함께 구현 |
| 7 | claude/ollama 요약 엔진 실호출 (템플릿 폴백은 검증됨) | 2주차 | — | 배포 후 scribe.log의 summary engine 라인 |
| 8 | §13-3 순환 실검증: 야간배치 1회 → 팩 자동 설치 → 다음 새벽 Sentinel → 고의 결함 run_fail→heal→run_pass | 3주차 | Q6 | 데스크톱에서 실제 파이프라인 1회 (ai-factory NIGHTCREW_DISCOVERY.md §D) |
| 9 | toss heal 후 재배포(ait deploy) 경로 — 코드는 있으나 실기기 미검증 | 3주차 | — | 고의 결함 순환 시 함께 확인 |
| 10 | KAIROS 데몬 비상주 확인 — worker 상주 운용이면 이중 수리 경합(ai-factory DISCOVERY §C) | 3주차 | Q6 | `KAIROS_ENABLED` 미설정 확인 |
| 11 | Sentinel-iOS 실기기 — 러너·판정은 스텁 테스트로 검증됨, Xcode 프로젝트 연결은 §9.3 설계 시 | 수시 | — | love_place Xcode scheme 확보 후 |

미결정 질문 상태: Q1(첫 팩 앱) **답변됨(2026-07-18): 사용자 앱들은 웹뷰 기반 iOS — 개발이 더 진행된 뒤 URL이 생기면 지정하기로 유보. 그때까지 fac_demo 더미 유지, 실앱 등록 시 필요한 것 = ①배포 URL ②핵심 화면 1~2개 ③protected/experimental 분류. 웹뷰 앱은 iPhone 뷰포트 에뮬레이션 + 브리지 구간은 화면 도달 확인까지(§7.1 논리)** / Q2(love_place 웹 URL): 웹뷰 기반으로 확인 — URL은 추후 / Q3(힐 상한 M) 미답·비차단(기본 4) / Q4(체크아웃 경로) 미답 — `~/nightcrew` 가정으로 구현됨 / Q5~Q8 미답. Q9(문서 수정)는 구현 승인에 포함된 것으로 보고 v2.1로 반영 완료.

---

**1~2주차 구현·검토 완료.** 3주차(Factory 훅, ai-factory 리포)는 §0 프로토콜에 따라 해당 리포에서 DISCOVERY부터 시작한다. 최소 Q1(첫 팩 대상)과 Q9(문서 수정) 답변이 있으면 1주차 전체를 완주할 수 있고, Q1 없이도 승인만 있으면 체크리스트 1~6(유틸+엔진 골격)까지는 더미 팩으로 진행 가능하다.
