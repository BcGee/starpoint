# StarPoint 구현 갭 전수조사 (2026-07-02)

SWF 전체 디컴파일(클라가 호출하는 API) × 서버 라우트(server.ts + 각 라우트파일) × CDN 추출본(1112 테이블) vs 서버 assets(44개) 3자 대조 결과.

방법:
- 클라 API: `/tmp/swf-am/scripts/` 전체에서 `prefix/action` 경로 문자열 추출
- 서버 라우트: `src/server.ts` register prefix + 각 `src/routes/api/*.ts`의 fastify.post/get
- 데이터: EC2 `scripts/in_extracted/**.json` vs `assets/*.json` (basename 대조)

---

## 분류 기준

프라이빗 싱글플레이 서버라 아래는 **구현 불필요 (무관)**:
- 카카오/인증 계열: `oauth`, `gxshield`, `take_over`, `take_over_register`, `agreement`, `application`, `tool/unregister`, `sns/update_twitter`, `follow/*`(친구), `lounge/*`(길드/라운지 온라인)
- 멀티플레이: `multi_battle_quest/*` (온라인 협동전 — 소켓 서버 필요, 싱글 무관)
- 결제: `payment/*` (실결제)
- 소셜: `character_election`(캐릭터 총선거 온라인 집계), `comic`, `episode_trial_reading`, `story_movie`(에셋 뷰어)

---

## P1 — 완전 미구현, 싱글플레이 핵심 (라우트 prefix 자체 없음)

### active_mission (스텝업 미션) ★ 최우선
- 클라 API: `active_mission/receive`, `active_mission/receive_incentive`, `active_mission/real_incentive_transitioned_url`
- 서버: 라우트 prefix 미등록. DB테이블(players_active_missions)·타입·get/insert 함수는 **이미 존재**
- 데이터: 추출본에 `active_mission`, `active_mission_event`, `active_mission_reward`, `real_incentive_mission_*` 있음 → assets 미변환
- 클라 표시: `/load`의 `active_mission_list: Option<Array<CommonResponseActiveMissionInfo>>`
  - Info: `{mission_id:Int, progress_value:Int(non-Option), stages:Option<Array<{stage:Int, received:Bool}>>}`
- 현재 `all_active_mission_list` 항상 `{}` → 스텝업 안 보임

### exchange (교환소) — star_crumb / bond_token
- 클라 API: `exchange/star_crumb`, `exchange/bond_token`, `exchange/get_bond_token_exchange_list`
- 서버: prefix 미등록
- 데이터: `shop/star_crumb_exchange`, `shop/star_crumb_exchange_cost`, `shop/bond_token_exchange` 추출됨, 미변환
- 임팩트: 스타크럼/본드토큰 교환 (중간 — 재화 교환)

## P2 — 진행/데이터 게이팅 (라우트 있음, 데이터·상태 문제)

### 보스 난이도 / 사이드퀘스트 해금
- 원인: quest_progress 선행체인 미충족 (서버버그 아님). 이미 `scripts/seed_boss_progress.js` 준비됨
- 데이터: `boss_battle_stage_node`, `game_system_unlock_condition` 추출됨 (클라가 CDN서 직접 읽음, 서버 assets 변환 불필요)
- 조치: seed 적용 (mode full/main)

### 이벤트 퀘스트 (advent/carnival/raid/rush/tower/story/world_story)
- 서버: 배틀 라우트 구현됨 (`getQuestFromCategorySync` 디스패치). raid/rush 이벤트 라우트도 등록됨
- 원인: servertime + CDN 스케줄 게이팅. 현재 day 53(≈2023-02-27)에 활성인 것만 표시
- 데이터: 이벤트 퀘스트 assets는 있음. 단 이벤트 스케줄/리스트 테이블(`event_list`, `advent_event`, `carnival_event` 등)은 CDN 클라측
- 조치: 시간 조정으로 원하는 이벤트 활성화 확인 (버그 아님)

### 데일리 미션 (mission STAGE2)
- 서버: `/mission/get_mission_progress` STAGE1(목록)만. STAGE2(진행추적/보상) 미구현
- 데이터: `daily_mission`, `regular_mission`, `event_mission` (+_reward), `mission_client_check` 추출됨. `mission.json`은 변환됨
- 조치: players_mission_progress 테이블 + 완료판정 + 보상 (별도 작업)

## P3 — 캠페인/교환 계열 (라우트 없음, 데이터 있음)

- `start_dash_exchange/*` (스타트대시 교환) — campaign 데이터 추출됨
- `special_exchange/*`, `multi_special_exchange/*` (특별교환 캠페인) — campaign 데이터 추출됨
- `box_gacha/reset` (박스가챠 리셋 — get_box_list/exec/close는 구현됨)
- `degree` (칭호) — profile/get_degree_list 등 미구현, degree/degree_category 데이터 있음
- `contents_guide/start` (콘텐츠 가이드)

## P4 — 개별 액션 갭 (prefix는 구현됨, 일부 액션 누락)

- profile: `rename`, `update_comment`, `update_degree`, `update_profile_settings`, `get_profile`, `get_degree_list` (get_my_profile만 구현)
- equipment: `bulk_upgrade`, `bulk_sell_stack` (단건만 구현)
- expod: `bulk_stack_to_exp` (단건만)
- encyclopedia: `unlock_keyword` (read_keyword/index만)
- shop: `recover_stamina`(스태미나 회복 구매), `get/set_campaign_lineup_id`
- news: `index`, `latest_forced` (get_info만)
- bonus: `shown_expired_premium`
- gacha: `shown_converted`, `tutorial_light`
- party: `refer`, `check_word`
- history: `practice_battle`, `score_attack_event_battle` (receive만)
- attention: `action`, `logger` (check만)

---

## 데이터 미변환 요약 (converter.py 갭)

converter.py가 핸들러 없어서 assets로 안 변환된 게임플레이 테이블 다수. 주요:
- active_mission 계열 5개 (P1)
- campaign 계열 10개 (P3 — 각종 교환 캠페인)
- equipment_enhancement 6개 (장비 강화 상점)
- mission 계열 12개 (STAGE2용)
- degree 2개 (칭호)
- 대부분의 event/quest 테이블은 클라가 CDN 직접 읽음 → 서버 변환 불필요

핵심: **"안 되는 것"의 대부분은 (1) 데이터 미변환 (2) 라우트 미등록 (3) 진행도/시간 게이팅** 세 부류.
클라 로직·CDN데이터는 다 있으므로 서버측 변환+라우트만 채우면 됨.
