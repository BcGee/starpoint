# active_mission (스텝업 미션) 전수조사 — 데이터·클라·서버 매핑

World Flipper 스텝업 미션(active_mission) 시스템의 CDN 마스터데이터, 클라이언트(SWF) 로직,
서버 구현을 전수조사한 참조 문서. **코드 수정 시 이 문서도 함께 갱신할 것.**

분석 방법: SWF 디컴파일(`/tmp/swf-am/scripts/`, ffdec) + mitmproxy 실트래픽(`/tmp/starpoint_api.log`)
+ 서버 소스(`src/`) 대조.

---

## 1. 데이터 흐름 개요

```
CDN 마스터(orderedmap)  --추출-->  scripts/in_extracted/active_mission/*.json
   --convert_active_mission.py-->  assets/active_mission.json (events + missions)
   --lib/activeMission.ts-->       /load 응답 all_active_mission_list  (진행/수령 상태)
                                   /active_mission/receive 응답 active_mission_list (즉시 갱신용)
클라: /load 로 미션 정의(CDN) + 진행상태(서버) 조합해 화면 구성
      receive 로 수령 → 응답의 active_mission_list 로 로컬캐시 즉시 갱신
```

---

## 2. CDN 마스터데이터 (원본)

EC2 `scripts/in_extracted/active_mission/` (boot_ffc6.as 경로: `/active_mission/*`):

| 파일 | 내용 |
|------|------|
| `active_mission.json` | 미션 정의 (63개: 스텝업44 + contents_guide9 + real_incentive10) |
| `active_mission_event.json` | 이벤트 정의 (3개: step_up_mission / contents_guide / real_incentive) |
| `active_mission_reward.json` | 미션별 보상 |
| `real_incentive_mission_ingame_reward.json` | 현금이벤트 인게임 보상 (미사용) |
| `real_incentive_mission_real_reward.json` | 현금이벤트 실물 보상 (미사용) |

### active_mission.json 행 구조 (인덱스)
`[0]`=event_id, `[1]`=stage(phase), `[2]`=category명(입문편/초급편…), `[3]`=pattern키
(step_up_1_character_episode 등), `[4]`=설명, `[54]`/`[55]`=기간(start/end).

### active_mission_event.json 행 구조
`[0]`=key(step_up_mission 등), `[1]`=이름, `[2]`=**kind**(0=스텝업, 3=real_incentive),
`[3]`=stageCount, `[14]`=start, `[15]`=end, `[16][17][18][22]`=need_quest(해금조건, 스텝업은 전부 None=무조건 해금).

### active_mission_reward.json 행 구조 (★중요 — reward kind)
슬롯: `[7]`=kind, `[8]`=amount, `[9]`=content_id(있으면 아이템/장비). `[10~]` 추가 슬롯 3칸 반복.
**kind 매핑 (이 테이블 전용, GeneralRewardKind enum과 다름 — blanc 인게임 증언으로 확정):**
- `0` = 성도석(stone) — id 없음. "미션 모두 클리어" 완주보상 300/600
- `1` = 아이템/장비 — id 있음. id>=100000 → equipment, 그 외 item
- `3` = 마나(mana) — id 없음. "마나보드"/"특별상품" 2000~15000
- `5` = 경험치(pooled_exp) — id 없음. "Lv강화 경험치"/"유니존 편성" 500~5000

⚠️ 함정: 처음에 3/5를 성도석으로 잘못 매핑 → 성도석만 쌓이고 마나/경험치 0. blanc "성도석 많은데
경험치·마나 안 온다"가 결정적 단서였음.

---

## 3. 변환 스크립트 — scripts/convert_active_mission.py

CDN 3파일 → `assets/active_mission.json`:
```json
{
  "events": { "1": { key, name, kind, stageCount, startDate, endDate } },
  "missions": { "11010": { eventId, stage, category, pattern, desc, startDate, endDate,
                           rewardsByStage: { "1": [{kind, id?, amount}] } } }
}
```
kind: stone/item/equipment/mana/pooled_exp/character/degree.
재실행: EC2 `python3 scripts/convert_active_mission.py` → `assets/active_mission.json` 생성.

---

## 4. 서버 코드 역할

| 파일 | 역할 |
|------|------|
| `src/lib/activeMission.ts` | assets 로드, 활성미션 계산(servertime), `/load` 직렬화(`serializeAllActiveMissionList`), 보상 조회(`getActiveMissionStageRewardsSync`), reward kind→RewardType 변환(`activeMissionRewardToReward`) |
| `src/routes/api/activeMission.ts` | `/active_mission/receive`(수령+보상지급+응답), `/receive_incentive`(현금이벤트 stub) |
| `src/data/wdfpData.ts` | DB: `getPlayerActiveMissionsSync`, `upsertPlayerActiveMissionStageReceivedSync`(멱등 수령기록) |
| `src/data/utils.ts` | `/load` 직렬화에서 `all_active_mission_list` 필드 채움(줄 ~333). deserialize(줄 ~779, 저장용) |
| `src/data/types.ts` | `PlayerActiveMission`, `ClientPlayerData.all_active_mission_list`(unknown — Map 직렬화) |
| `src/data/initializers/wdfpData.ts` | 테이블 `players_active_missions`(id,progress,player_id), `players_active_missions_stages`(id=stage,status=received,mission_id,player_id) |
| `src/server.ts` | 라우트 등록 `/active_mission`, msgpack pack(msgpackr) |

### reward kind → 서버 RewardType (activeMissionRewardToReward)
stone→BEADS(무료성도석 free_vmoney), mana→MANA(free_mana), pooled_exp→EXP(exp_pool),
item→ITEM, equipment→EQUIPMENT, character→CHARACTER.

---

## 5. 클라이언트(SWF) 로직 — ★핵심 파이프라인

### /load 응답 파싱: all_active_mission_list
- 필드명은 **`all_active_mission_list`** (NOT `active_mission_list` — 그건 receive 응답 필드). 함정1.
- 스키마: **`Map<missionId(int), {progress:int, stages:Map<stageId(int),bool>, ingame_status, ingame_reward_id}>`**
- 클라 변환(SWF): `clearedStages[int(stageId)] = stages[stageId] ? 2 : 1`
  - 서버 stages `true`(수령됨) → clearedStages `2`(AlreadyReceived=회색)
  - 서버 stages `false`(미수령) → clearedStages `1`(수령가능)
- ⚠️ **함정2 (int-key msgpack)**: 클라는 missionId/stageId를 **int key로 조회**(`h[int(1)]`).
  JS 객체 `{"1":true}`는 msgpack이 **string key**로 인코딩 → 조회 실패 → 회색 안 됨.
  **반드시 JS `Map`으로 만들어야** msgpack이 int key로 인코딩(hex `81 01 c3`). serializeAllActiveMissionList가 Map 반환.

### 미션 표시/완료 판정 (SWF ActiveMissionStageLogic)
- `isCompleted()` = `target_progress <= missionLogic.getProgress()`. 서버가 progress=999999 주면 전 스테이지 완료(수령가능) 노출.
- 개별 스테이지 수령완료(회색) = `clearedStages[stage] == 2` (`isMissionClearAndReceived`).
- 이벤트 전체 수령완료 시 → `isActiveMissionEventAllClearAndReceived` → **이벤트가 목록에서 사라짐**(정상). 함정3: "다 받았더니 안 보임"은 버그 아님.
- 이벤트 해금: `isUnlocked` = `need_quest` 없으면 true. 스텝업은 무조건 해금.

### receive 흐름 (★즉시 회색 + 재화 즉시 반영)
1. 클라: `getLoadedData().clearedActiveMissions`에서 미수령(clearedStages==1) 스테이지 수집
2. `POST /active_mission/receive` body: `{active_mission_list: [{mission_id, stages:[stageId...]}]}`
3. 응답 처리: **`applyCommonResponse(data)`** 가 공통으로 처리 —
   - `data.active_mission_list` → `applyCommonResponseActiveMission` → `applyActiveMissionToLoadedData`
     로 로컬 clearedStages 갱신 (stage.received=true → clearedStages=2 → **즉시 회색**)
   - `data.user_info` → `applyCommonResponseUserInfo` 로 재화(free_mana/exp_pool/free_vmoney 등)
     **즉시 화면 갱신**. user_info 각 필드는 Option — 서버가 담은 필드만 갱신(부분).
4. `reloadMission()` → `setupMission()`가 갱신된 로컬캐시 다시 읽어 화면 재구성
- ⚠️ **함정4**: receive 응답 `data`가 비면(`{}`) 로컬캐시/재화 갱신 안 됨 → 즉시 회색·재화반영 실패.
  응답에 반드시:
  - `active_mission_list: [{mission_id, progress_value, stages:[{stage, received:true}]}]` (회색)
  - `user_info: {free_mana, exp_pool, free_vmoney, ...}` — **지급 후 절대값**(증분 아님, 클라가 덮어씀) (재화)
- receive 응답의 stages는 **Array<{stage, received}>** (load의 Map과 다름! CommonResponseActiveMissionInfo 스키마).
- ⚠️ **함정5 (지급 스킵)**: `upsertPlayerActiveMissionStageReceivedSync`가 이미 status=1이면 `newlyReceived=false`
  반환 → 보상 지급 스킵. DB에 수령기록 남은 채 재테스트하면 "표시는 되는데 재화 안 들어옴"처럼 보임.
  깨끗한 재현엔 DB 리셋 필요.

---

## 6. 확정된 함정 요약

1. `/load` 필드명은 `all_active_mission_list` (receive 응답은 `active_mission_list`)
2. stages/missionId는 int-key여야 함 → JS Map 사용 (string-key면 클라 조회 실패)
3. reward kind: 0=성도석 1=아이템/장비 3=마나 5=경험치 (enum과 다름)
4. receive 응답에 `active_mission_list`(회색) + `user_info`(재화 절대값) 둘 다 담아야 즉시 반영
5. 이벤트 전체 수령 시 이벤트 자체가 사라지는 건 정상
6. 이미 수령(status=1)한 스테이지 재수령 시 지급 스킵 → 재테스트 전 DB 리셋

## 7. 최종 상태 (2026-07 완료, blanc 인게임 검증)

스텝업 미션 **완전 작동 확인**:
- 미션 표시 ✓
- 보상 지급 5종 정확 ✓ (성도석/아이템/장비/마나/경험치)
- 받는 즉시 회색(수령완료) ✓ (receive 응답 active_mission_list)
- 받는 즉시 재화 화면 반영 ✓ (receive 응답 user_info)
- 재접속 후 상태 유지 ✓ (/load all_active_mission_list int-key Map)

관련 커밋: 34acec7(필드명), ee10f7a(int-key), + receive user_info 추가.
