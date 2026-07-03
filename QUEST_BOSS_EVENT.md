# Quest / 보스 / 이벤트 시스템 전수조사 (서버 + 클라이언트)

World Flipper 프라이빗 서버(starpoint) 퀘스트·보스·이벤트 전수조사. **서버 코드 + 클라(SWF) 로직 + CDN 데이터 3자.**
코드 수정 시 이 문서도 갱신 (blanc 규칙). 관련: `ACTIVE_MISSION.md`, skill `starpoint-server-dev`.

분석 소스: SWF 디컴파일 `/tmp/swf-am/scripts/`(ffdec), mitmproxy `/tmp/starpoint_api.log`(EC2), 서버 `src/`.

---

## 1. 클라 API 계약 (SWF startUserRequest/sendOnlyUserRequest) vs 서버 라우트

클라가 실제 호출하는 API. **★=서버 미구현(라우트 없음) → 404 → 기능 실패 가능.**

### 배틀/퀘스트
| 클라 API | 요청 바디 | 서버 |
|---|---|---|
| single_battle_quest/start | {quest_id,category,party_id,use_boost...} | ✓ singleBattleQuest.ts |
| single_battle_quest/finish,/abort,/play_continue | ... | ✓ |
| story_quest/finish | ... | ✓ storyQuest.ts |
| **quest/unlock** | **{category, quest_id}** | **★없음** — 잠긴 퀘스트 해금요청. 아래 §4 |
| **quest/get_recent_other_player_party** | ... | ★없음 (멀티 파티 추천, 싱글 무관) |
| multi_battle_quest/* (start,finish,prepare,create_room…) | ... | 대부분 ★없음(get_rooms만) — 온라인 협동, 싱글 무관 |

### 이벤트 (event/raid, event/rush 는 서버 구현됨)
| 클라 API | 서버 |
|---|---|
| event/raid/get_boss,summary,party,ranking_reward | ✓ raidEvent.ts (get_boss만? 확인) |
| event/raid/battle/start | ★ raidEvent.ts 확인 필요 |
| event/rush/summary,select_folder,ranking,party,battle/start,reset,aggregated_time,endless_battle,reward | ✓ rushEvent.ts |
| carnival_event/index,get_party | ★없음 — carnival 라우트 미등록 |
| character_election/get_vote_status,vote | ★없음 (총선거, 온라인) |
| history/practice_battle,score_attack_event_battle | ★없음 (history/receive만) |

### 기타 미구현(★) — 대부분 싱글플레이 무관
profile/(rename,get_profile,update_*,get_degree_list), equipment/(bulk_*), expod/bulk_stack_to_exp,
news/(get_info는✓, latest_forced★), payment/*, follow/*(친구), lounge/*(길드), take_over*/oauth(카카오),
contents_guide/start, shop/recover_stamina, multi_special_exchange/*, start_dash_exchange/*, exchange/*(교환소),
box_gacha/reset, party/check_word, sns/update_twitter, agreement, gxshield, episode_trial_reading, story_movie.

---

## 2. 카테고리 → 데이터 디스패처 (src/lib/assets.ts:213 getQuestFromCategorySync)

QuestCategory(src/lib/types.ts:23): 0=EMPTY 1=MAIN 2=BOSS_BATTLE 3=CHARACTER 4=EX 6=DAILY_WEEK
7=ADVENT_SINGLE 8=ADVENT_MULTI 10=STORY_EVENT 11=RANKING 13=CHALLENGE_DUNGEON 14=DAILY_EXP_MANA
18=WORLD_STORY 19=WORLD_STORY_BOSS 20=TOWER 21=EXPERT 22=CARNIVAL 23=RAID 24=RUSH 25=SOLO_TA 26=SCORE_ATTACK.
→ 각각 assets/*.json 로 매핑, 전부 구현. **default→null**(미매핑/questId없음 시 라우트 400/500).

## 3. quest_progress (해금 데이터)

- `/load`: `quest_progress: {section: [{quest_id, finished, clear_rank, high_score, best_elapsed_time_ms}]}`.
  section = QuestCategory 값(1=MAIN,2=BOSS…). ⚠️ msgpack key 타입: 클라 조회 방식 확인 필요(int-key 여부 — ACTIVE_MISSION.md 함정2 참고).
- DB `players_quest_progress`. `/finish` 가 기록. 신규 플레이어 빈 진행.

## 4. ★ quest/unlock — 사이드퀘/보스 해금 핵심 (서버 미구현!)

**클라 로직** (SWF QuestUnlockRealRemote):
- 클라가 잠긴 퀘스트 진입 시도 시 `POST quest/unlock {category, quest_id}` 전송
- 성공(200)하면 successHandler가 응답 body 무시하고 `QuestUnlockRemoteInput.Unlocked(category, questId)`로
  **로컬에서 해당 퀘스트 해금** 처리
- **서버에 `quest/unlock` 라우트 없음 → 404 → 클라 해금 실패.** 사이드퀘/특정 퀘스트가 안 열리는 유력 원인.

**해결안**: `/quest/unlock` 라우트 추가 — {category, quest_id} 받아서 players_quest_progress 에 unlocked/finished 기록(또는 최소 200 응답). 응답 body는 클라가 안 쓰므로 `data:{}` 충분할 수 있음(단 msgpack Object). **검증 필요.**

## 5. 보스 배틀 (오로치=1014)

- 난이도 해금: 클라 CDN(`boss_battle_quest` prereq[11], `boss_battle_stage_node` viewable/selectable_need_quest) + quest_progress finished 판정. 서버 assets엔 prereq 없음.
- boss quest_id: `BBBBDDD`. 오로치=1014 → 1014001~. `/single_battle_quest/start` category=2.
- seed: `scripts/seed_boss_progress.js`.

### ⚠️ 오로치 진입 크래시 (진단 완료 — 클라/CDN 영역)
- **진행도 시드(seed_all_progress.js) 후 진입·전투·클리어 성공.** 원래 "진입 시 에러"는 진행도 부족(prereq 미클리어)이 원인이었고 해소됨.
- 클리어 후 크래시: mitm 로그 시퀀스 `single_battle_quest/finish(200) → attention/check → story_quest/finish(200) → reproduce/post → attention/check → [재접속]`.
  - 오로치(1014)는 클리어 시 **스토리 이벤트를 트리거**하는 보스(story_quest/finish 호출됨).
  - 두 finish 응답 다 정상 200, 클라 successHandler는 누락 필드를 null→Option.None 안전 처리(크래시 아님).
  - 마지막 attention/check 후 **서버 API 없이 클라 로컬에서 크래시** → 클리어 후 스토리 컷신/연출 재생 단계.
- **결론: 서버 응답 문제 아님. 오로치 클리어 후 재생되는 스토리 컷신의 CDN asset 누락/손상 또는 클라 로컬 처리 문제. 서버로는 수정 불가.**
  (CDN story asset 존재 여부 조사 시 boot_ffc6.as의 story/adv 경로 + entities 파일 확인)

## 6. 이벤트/사이드퀘 노출 로직

- servertime 게이팅: 클라가 CDN 스케줄 + 서버 servertime 비교. 현재 게임시간에 활성인 것만. 시간은 systemd 타이머(advance-server-time.sh).
- game_system_unlock_condition(CDN): 메인퀘 진행도로 게이팅.
- "이벤트/사이드퀘 안 보임" 진단 순서: (1)서버시간 이벤트기간 내? (2)game_system_unlock (3)quest/unlock 404? (4)event_quest assets 존재?

---

## 7. 확정 함정 / 원칙

1. **클라 API 계약을 항상 SWF startUserRequest 로 먼저 추출** — 서버 라우트와 대조해 미구현(★) 갭 파악. 이게 "안 됨"의 1순위.
2. quest/unlock 은 서버 미구현 — 사이드퀘/보스 해금 실패 유력 원인.
3. 클라는 대부분 응답 body 안 읽고 성공(200)+로컬 처리 → 서버는 200 + 올바른 msgpack Object면 충분한 경우 많음.
4. msgpack key 타입(int vs string) 함정 — ACTIVE_MISSION.md 참고.
5. 이벤트 배틀 로직은 다 구현됨 — "안 됨"은 데이터/시간/해금(quest_unlock) 게이팅이지 라우트 부재 아닌 경우 많음.

## 8. 미션 시스템 (get_mission_progress) — 서머/캠페인 세부미션 안 뜸 ★해결(2026-07-03)

**근본원인 확정 (SWF + mitm + 디버그로그):**
- 클라 요청: `{category_list: [{category:4, event_id:X}]}`. 미션 화면을 열면 그 이벤트의 event_id 를 담아 보냄.
  실측: 하니와/서머 화면 → `{event_id:10010, category:4}`.
- **event_id 10010 = `srm21_3_campaign_mission` (캠페인 미션, collect_item_event 정의)**, 기간 2023-03-25~04-09.
  그 미션들은 `collect_item_event_mission.json` 의 각 행 `[0]==event_id` 로 묶임 (id 1915~1950, 36개).
- ❌ 예전 mission.ts: **event_id 를 무시**하고 `mission.json["3"]`(event_mission=startdash/summer 2051~2068) 활성분을 전부 반환.
  클라는 자기가 연 이벤트(event_id 10010)의 미션만 화면에 필터 → 받은 2051~ 은 event 10010 소속이 아니라 **전부 걸러짐 → "세부미션 0개"**.
  (즉 서버는 200+18개 미션을 보냈지만 클라 화면엔 안 뜬 것 — 빈배열이 아니라 "엉뚱한 이벤트 미션"이 문제였음.)

**수정 (배포 완료):**
- `scripts/convert_mission.py`: `collect_item_event_mission.json` 을 event_id 별로 변환 → `mission.json["eventMissions"]["<event_id>"]`.
  행 스키마: `[0]=event_id [1]=stage [2]=pattern [3]=desc [4]=target [21]=start [22]=end`. 24개 이벤트, 708개 미션.
- `src/routes/api/mission.ts`: 요청에 `event_id` 있으면 `activeEventMissions(event_id, now)` 로 **그 이벤트의 미션만** 서빙(기간필터 + 각 미션의 stage). event_id 없으면 기존대로 category(1=regular/2=daily) 서빙.
- 검증: 배포본에서 event 10010 @ 2023-04-05 → 캠페인 미션 28개(1915~1942, 04-05 활성분), @04-08 → 36개. PASS.
- ⚠️ successHandler 스키마: `{mission_category:int, mission_id:int, progress_value:Float, stage:int}`.
  progress_value 는 Float 기대지만 AS3 에선 int 이 Number 라 0 도 통과(크래시 아님). stage 는 미션 정의값 사용.
- ⚠️ 다른 이벤트(서머 등)도 각자 event_id 로 열림. event_mission.json(cat3, 2051~) 은 startdash/구서머 등 pattern 기반 별개 계열 — 클라가 event_id 로 안 여는 것들.

## 9. 하니와(carnival_event) — 파티리스트 필드명 불일치 ★해결(2026-07-02)

- carnival_event/index 는 200 인데도 클라가 응답 디코드 중 크래시 → 재접속 루프.
- 원인(SWF validator 확정): `user_party_group_list[].party_list[]` 원소 필드명이 /load(맵형)과 다름.
  carnival(배열형)은 **`party_name`/`party_edited`/`party_id`** 필수. 서버가 /load 필드명(`name`/`edited`, party_id 누락)으로 보내
  → 8702(party_name)/8703(party_edited)/8700(party_id) throw → 크래시.
- 수정: `serializeCarnivalPartyGroups` 가 party_id(slot)/party_name/party_edited 내보내게. 배포+실DB검증 완료.

## 10. TODO
- [x] quest/unlock 라우트 구현 (배포됨)
- [x] 진행도 전량 시드 (seed_all_progress.js) → 오로치 진입·클리어 됨
- [x] 오로치 크래시 진단: 서버 정상, 클리어후 클라 스토리컷신 로컬크래시 (logcat 필요)
- [x] **미션 서머/캠페인 안뜸 원인 확정 + 수정**: event_id 무시가 원인 → eventMissions[event_id] 서빙 (배포됨)
- [x] **하니와 재접속 루프 수정**: party_* 필드명 (배포됨)
- [ ] item/sell, item/use_item 라우트 (조사완료, 미구현): 아이템 판매(마나)/사용(스태미나)
- [ ] 오로치: ADB logcat 으로 클라 크래시 스택 확보 (서버측 수정 불가 결론)
