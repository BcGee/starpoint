# Starpoint 야간 자율작업 요약 (2026-07-02 새벽)

blanc이 자는 동안 "전부 다 해"에 따라 CDN 마스터데이터 추출 파이프라인 구축 +
가챠/미션 구현을 진행했음. git push는 안 함(원칙대로). 서버 배포(rsync+restart)는
이 세션 계속 해온 방식이라 진행함.

## ✅ 완료 (배포 + 검증됨)

### 1. CDN 마스터데이터 추출 파이프라인 (재사용 자산)
wdfp-extractor(Electron GUI) 없이 headless로 CDN에서 마스터데이터 추출하는 도구 완성.
- `scripts/extract_master.js` — boot_ffc6.as의 457개 경로 → SHA1(path+salt) digest →
  entities CSV 3단계 매핑 → orderedmap 디코드. **416개 추출** (5 missing=bundled, 36 fail=비-orderedmap)
- `scripts/extract_gacha_odds.js` — gacha odds 별도 추출 (**696개**, boot_ffc6에 없어서 gacha.json에서 이름 수집)
- `scripts/_readOrderedMap.js` — orderedmap 디코더 (csv-parse 의존성 제거, Node stdlib만)
- `scripts/convert_mission.py` — mission 마스터 → assets/mission.json
- 전부 스킬에 저장됨: `~/.hermes/skills/gaming/starpoint-server-dev/scripts/`
- 상세: 스킬 `references/cdn-masterdata-extraction.md`
- **게임 EOS라 CDN 고정 = 이 추출은 진짜 1회로 끝. 앞으로 재추출 불필요.**

### 2. 유료/확정 가챠 (800005 등) — 400 해결
- `converter.py`의 `convert_gacha`가 `[4]==0`(일반 kind)만 처리 → 유료/스텝업(kind 1~7) 20개 스킵이 원인
- `[4]`는 payment_type이 아니라 **가챠 kind**임을 확인 (0=일반,1=800xxx스텝업,2=복주머니,3=★4확정,4=신년,7=컴백)
- convert_gacha 재작성: 모든 kind 처리, cost는 [5-7] 또는 [8] 폴백
- **assets/gacha.json: 224 → 244개** (800005 "스타 히어로즈" SR확정 포함). 기존 224개 회귀 0.
- EC2 배포 완료. 서버 getGachaSync(800005) 로드 확인.
- 백업: `assets/gacha.json.bak-<timestamp>`

### 3. 무료10연차가 유료 데일리스택 소모하던 버그 (이전 세션 이어서)
- `gacha/exec`가 payment_type 무관하게 매 뽑기 `isDailyFirst=false` → 무료뽑기가 유료소환 잠금
- `consumedDailyFirst` 플래그로 VMONEY(유료데일리)만 소모하게 수정. 배포됨.

### 4. 일일미션 STAGE 1 (목록 표시) — 배포됨
- `convert_mission.py` → assets/mission.json (1898개: regular 120 / daily 284 / event 1494)
- `mission.ts` get_mission_progress 재작성: 서버시간 활성 미션을 progress=0으로 반환 → 게임에 미션 목록 뜸
- 검증: 2023-03-02 기준 category 2(데일리) = 6,7,8,9,10 (캡처 응답과 일치)
- EC2 배포 완료.

## ⏳ 남은 것 (blanc 확인/결정 필요 — 밤새 자동으로 안 한 이유)

### 미션 STAGE 2 (진행도 저장 + 보상) — DB 스키마 필요
- 현재 update_mission_progress는 클라 진행도를 받되 저장 안 함(빈 응답)
- 완성하려면 `players_mission_progress` 테이블 신설 + 완료판정 + `*_mission_reward` 지급
- DB 마이그레이션이라 회귀 위험 → blanc 확인 후 진행 권장

### 보스 난이도/로테이션 — 서버로 못 고침 (구조적)
- boss_battle_stage_node(난이도그래프) + schedule(로테이션 23개) 둘 다 **CDN 클라이언트사이드**.
  서버 소스에서 참조 안 함. 클라가 CDN에서 직접 읽고 servertime+quest_progress로 판단.
- "높은 난이도 안 뜸" = quest_progress에 이전난이도 클리어 없음 (실제 플레이 or DB 시드 필요)
- "보스 안 바뀜" = 서버시간 고정 때문. 데이터/코드 문제 아님.

## 게임에서 확인 부탁 (blanc)
1. 스타히어로즈 등 유료확정 가챠(800005) — 이제 400 안 나고 돌아가는지
2. 무료 10연차 후에도 유료 데일리소환 되는지
3. 일일퀘스트 목록 뜨는지 (수령/진행은 STAGE 2 필요)

## 서버 상태 (작업 종료 시점)
- active, 에러로그 없음. gacha 244 / mission 1898 로드. 서버시간 2023-03-05(자동전진 중).
