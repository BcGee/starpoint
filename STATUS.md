# Starpoint (World Flipper 사설서버) 진행상황

_최종 업데이트: 2026-07-02. blanc 요청으로 작성. git push 안 함._

## 한 줄 요약
CDN 마스터데이터 추출 파이프라인 구축 완료 → 유료가챠·일일미션 데이터 확보/배포.
가챠 배너 "화면 표시" 문제는 **보류**(돌 무한이라 실익 없음, blanc이 다시 하자고 할 때만 재개).

---

## ✅ 완료 (배포 + 검증됨)

### 1. CDN 마스터데이터 추출 파이프라인 (재사용 자산, 1회로 영구)
게임 EOS(2024-07-25 종료)라 CDN 고정 → **한 번 추출하면 끝, 재추출 불필요.**
- 스크립트 (스킬 `gaming/starpoint-server-dev/scripts/`에 저장됨):
  - `extract_master.js` — boot_ffc6.as의 457경로 → SHA1(path+"K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy") → entities CSV 3단계매핑 → orderedmap 디코드. **416개 추출**
  - `extract_gacha_odds.js` — gacha odds 별도추출 (**696개**, boot_ffc6에 없어서 gacha.json에서 이름수집)
  - `_readOrderedMap.js` — orderedmap 디코더 (csv-parse 무의존, Node stdlib만)
  - `convert_mission.py` — mission 마스터 → mission.json
- 3단계 매핑: `master/<path>.orderedmap` → SHA1 digest hex → entities CSV col1(`upload/2자/38자`)→col4(base64url키) → `.cdn/ko/entities/files/<키>`
- 상세: 스킬 `references/cdn-masterdata-extraction.md`

### 2. 유료/확정 가챠 데이터 — gacha.json 224→244개
- 원인: `convert_gacha`가 `[4]`를 payment_type으로 오해 → 실제는 gacha **kind**(0=일반,1=800xxx스텝업,2=복주머니,3=★4확정,4=신년,7=컴백). kind 1~7 (20개) 전부 스킵됨
- 수정: 모든 kind 처리. 800005(스타히어로즈 SR확정 1500) 등 포함. 기존 224개 회귀 0
- **배포됨.** 서버 getGachaSync(800005) 로드 확인

### 3. 무료10연차가 유료 데일리스택 소모하던 버그
- 원인: `gacha/exec`가 payment_type 무관하게 매 뽑기 `isDailyFirst=false`
- 수정: `consumedDailyFirst` 플래그로 VMONEY(유료데일리)만 소모. **배포됨**

### 4. 일일미션 STAGE 1 (목록 표시)
- `mission.json` 1898개 (regular 120 / daily 284 / event 1494)
- `mission.ts` get_mission_progress가 서버시간 활성 미션 반환 → 게임에 미션 목록 뜸
- **배포됨.** get_mission_progress 200 확인됨 (게임이 실제 호출 중)

### 5. 메일 c8702 + receive_time sentinel (이전 세션)
- 미수령 메일 `receive_time`을 `"0000-00-00 00:00:00"`(클라 sentinel)로. 배포됨

---

## ⏸️ 보류 (blanc이 "하자"고 하면 재개)

### 가챠 배너 "화면 표시" 안 됨 — 데이터는 정상, 표시가 안 뜸
- 서버 데이터 전부 정상: gacha.json에 800005 있고, DB gacha_info도 있고, 서버시간(2023-03-01)도 기간 내
- 근데 게임 가챠 화면에 배너가 안 뜸
- 확인된 것: 배너 목록은 서버 API가 아니라 **클라가 CDN 마스터데이터 + /load의 gacha_info_list 조합으로 로컬 구성**. 클라가 최근 CDN(/patch) 재요청 안 함 = 로컬 캐시 사용 중
- 미해결 가설: (A) 클라 CDN 캐시가 옛날 상태로 굳음 → 앱 완전재시작/에셋재download 필요, (B) 800005는 과거배너라 최종 CDN 스냅샷 스케줄에서 빠짐, (C) 별도 탭(스텝업 전용)에 있음
- **결론: 돌 무한이라 실익 없음. 중단. blanc이 다시 하자고 할 때만 mitmproxy로 실트래픽 캡처해서 A/B/C 판별.**

## ⏳ 미착수 (설계만, blanc 결정 필요)

### 미션 STAGE 2 (진행도 저장 + 보상) — DB 스키마 필요
- 현재 update_mission_progress는 클라 진행도 받되 저장 안 함(빈 응답)
- 필요: `players_mission_progress` 테이블 신설(player_id, mission_id, category, progress, stage, received) — **1회 신설로 데일리/상시/이벤트 전부 커버, 미션 늘어도 row만 추가**
- 로직: 완료판정(progress>=target) + `*_mission_reward` 지급 + 데일리 리셋
- 테이블은 1회지만 완료/보상/리셋 흐름은 구현하며 게임반응 1~2회 검증 권장

### 보스 난이도/로테이션 — 서버로 못 고침 (구조적)
- `boss_battle_stage_node`(난이도그래프) + `boss_battle_multi_pickup_event_schedule`(로테이션 23개) 둘 다 **CDN 클라이언트사이드**. 서버 소스 참조 안 함
- "높은 난이도 안 뜸" = quest_progress에 이전난이도 클리어 없음 (실제플레이 or DB시드)
- "보스 안 바뀜" = 서버시간 고정 문제. 데이터/코드 문제 아님

### 유료 데일리 소환 자동 리셋 (부수 발견)
- 800005 같은 payment_type=2 배너는 하루 1회(`is_daily_first`) 제한인데 서버에 날짜변경 시 자동 리셋 로직 없음
- 지금은 수동 `UPDATE players_gacha_info SET is_daily_first=1`로 풀어야 함
- mail 데일리보너스처럼 `/load`에서 서버시간 날짜 바뀌면 리셋하는 로직 추가하면 근본 해결

---

## 환경 메모
- EC2 i-03d8f9cd132ac813e, 43.203.29.210, ap-northeast-2, PEM `/mnt/c/workspace/ytlee.pem`(→ /tmp/ytlee.pem chmod 600)
- 서버 재시작: `ssh ... "sudo systemctl restart starpoint"`
- 서버시간: `curl 'localhost:8000/api/server/time?time=YYYY-MM-DDThh:mm:ss'`, offset은 `~/starpoint/.server-time-state` (2023-01-07 기준 +N일, 3일점프)
- 빌드: 로컬 `npx tsc` → `rsync out/... EC2` (t3.small OOM으로 EC2 빌드 금지)
- assets JSON은 런타임 require라 rsync만으로 반영 (재빌드 불필요)
- 배포는 이 세션 계속 진행함. **git push만 blanc 명시 지시 필요**
- 로컬 추출물 `scripts/in/`(96MB), `scripts/out/`, `gacha.json.bak-*`는 .gitignore 처리됨
