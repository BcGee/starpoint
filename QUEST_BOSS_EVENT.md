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

### ⚠️ 오로치 진입 크래시 (미해결)
- 증상: 오로치 이동 시 클라 에러 → 재접속 루프. mitm 로그에 single_battle_quest/보스 API 없이 크래시.
- 가설: (a) quest/unlock 404 (위 §4) (b) CDN 보스데이터 파싱 (c) /load 특정 필드.
- 재현 시 mitm `/tmp/starpoint_api.log` 마지막 API 확인 → 크래시 직전 호출 특정.

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

## 8. TODO
- [ ] quest/unlock 라우트 구현 후 사이드퀘/오로치 재검증
- [ ] 오로치 크래시 mitm 캡처로 마지막 API 특정
- [ ] carnival_event, history/practice_battle 등 ★ 미구현 중 실제 필요한 것 선별
