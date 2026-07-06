// 스텝업(active_mission) 진행도 서버 계산.
//
// 배경 (SWF 디컴파일로 확정):
//  - 클라 완료판정: isCompleted = target_progress <= progress   (target = active_mission_reward[3])
//  - 클라의 getProgress() 는 `return progress` — 서버가 /load 의 all_active_mission_list 로 준
//    progress 를 그대로 반환할 뿐, 클라는 재계산하지 않는다.
//  - 스텝업 진행도를 클라가 push 하는 API 는 없다 (MissionCounterLogic.send 는 홈/UI 미션 5종만 push:
//    character_detail_zoom_illust_for_1min_count 등). 따라서 서버가 progress 를 계산해야 한다.
//
//  => 이 모듈이 플레이어 DB 상태(퀘스트 진행/보유 캐릭터/장비/파티 등)로 각 스텝업 미션의
//     실제 progress 를 계산한다. 이전엔 progress 를 999999 로 하드코딩해서 신규 계정도 44개
//     전부 클리어로 노출됐다 — 그 버그를 잡는다.
//
// 판정 원칙:
//  - DB 로 확실히 판정 가능한 조건(퀘스트 클리어/캐릭터·장비 보유/진화/유니존 편성 등)은 실제 계산.
//  - 서버가 상태로 추적하지 않는 순수 UI/일회성 액션(에피소드 열람, 특별상품 구입, 마나보드 해방,
//    Lv강화 경험치주입, 보스코인 교환, 연습배틀 도전, 어빌리티 소울 장착)은 progress 0 으로 둔다.
//    (클라 push 도, 서버 기록도 없어 현재로선 판정 불가. 무근거로 완료 처리하지 않는다.)

import { QuestCategory } from "./types"

// 진행도 계산에 필요한 플레이어 상태. serializeAllActiveMissionList 에서 한 번만 조회해 넘긴다.
export interface StepUpProgressContext {
    questProgress: Record<string, { questId: number, finished: boolean }[]>
    characters: Record<string, { evolutionLevel: number, overLimitStep: number, exp: number }>
    equipment: Record<string, { level: number, enhancementLevel: number }>
    parties: { unisonCharacterIds: (number | null)[], equipmentIds: (number | null)[] }[]
    bondTokenCount: number
}

// 메인퀘 quest_id = 1 + CCC(장, 3자리) + NNN(스테이지). 예: 1001001 = 1장, 1007002 = 7장.
// "N장 클리어" = section=MAIN 에서 chapter==N 인 finished 퀘스트가 하나라도 있으면 클리어로 본다.
function mainChapterCleared(questProgress: StepUpProgressContext["questProgress"], chapter: number): boolean {
    const mainBucket = questProgress[String(QuestCategory.MAIN)] || []
    const lo = 1000000 + chapter * 1000 // 1CCC000
    const hi = lo + 999 // 1CCC999
    for (const q of mainBucket) {
        if (q.finished && q.questId >= lo && q.questId <= hi)
            return true
    }
    return false
}

// 특정 섹션에 finished 퀘스트가 하나라도 있나.
function anyClearedInSection(questProgress: StepUpProgressContext["questProgress"], section: number): boolean {
    const bucket = questProgress[String(section)] || []
    return bucket.some(q => q.finished)
}

// 특정 섹션의 finished 퀘스트 개수.
function clearedCountInSection(questProgress: StepUpProgressContext["questProgress"], section: number): number {
    const bucket = questProgress[String(section)] || []
    return bucket.reduce((n, q) => n + (q.finished ? 1 : 0), 0)
}

// 스텝업 미션 패턴 → 현재 진행도(number) 계산.
// 반환값이 그 미션의 target 이상이면 클라가 완료로 판정한다.
// 판정 불가(순수 UI 액션)는 0 반환.
//
// questProgress/characters/equipment/parties 는 호출부에서 한 번만 조회해 넘긴다(반복 조회 방지).
export function computeStepUpProgress(pattern: string, ctx: StepUpProgressContext): number {
    const { questProgress, characters, equipment, parties } = ctx
    const charList = Object.entries(characters) // [idStr, char]
    switch (pattern) {
        // ── 입문편 (11xxx) ──────────────────────────────────────────────
        case "step_up_1_main_1_clear": return mainChapterCleared(questProgress, 1) ? 1 : 0
        case "step_up_1_main_2_clear": return mainChapterCleared(questProgress, 2) ? 1 : 0
        // 한 속성의 데일리 흔들리는 미궁 클리어 / 경험치·마나 미궁 클리어 → DAILY_EXP_MANA_EVENT(14) 클리어로 판정
        case "step_up_1_any_daily_element": return anyClearedInSection(questProgress, QuestCategory.DAILY_EXP_MANA_EVENT) ? 1 : 0
        case "step_up_1_daily_exp_mana": return anyClearedInSection(questProgress, QuestCategory.DAILY_EXP_MANA_EVENT) ? 1 : 0
        // 장비 장착: 파티에 실제 장착된 장비가 있는지 (보유가 아니라 편성) — 튜토리얼 기본지급
        // 장비를 "보유=완료"로 오판하지 않도록 파티 equipmentIds 로 판정.
        case "step_up_1_equip_equipment":
            return parties.some(p => (p.equipmentIds || []).some(id => id !== null && id !== undefined)) ? 1 : 0
        // 장비 각성(enhancement): enhancement_level>0 인 장비 보유
        case "step_up_1_equip_upgrade": return Object.values(equipment).some(e => e.enhancementLevel > 0) ? 1 : 0
        // 유니존 캐릭터 편성: 파티에 unison 캐릭터가 하나라도 세팅됨
        case "step_up_1_unison_character_set":
            return parties.some(p => (p.unisonCharacterIds || []).some(id => id !== null && id !== undefined)) ? 1 : 0
        // ── 초급편 (12xxx) ──────────────────────────────────────────────
        case "step_up_2_main_3_clear": return mainChapterCleared(questProgress, 3) ? 1 : 0
        case "step_up_2_main_4_clear": return mainChapterCleared(questProgress, 4) ? 1 : 0
        // 캐릭터 Lv40 이상: exp>=Lv40 기준(1성 40레벨 cap 11416)인 캐릭터 존재. target=40 이지만
        // 완료판정은 "40 이상인 캐릭터 1명" 의미 — 조건 충족 시 target(40) 을 채워 반환.
        case "step_up_2_character_level":
            return charList.some(([, c]) => c.exp >= 11416) ? 40 : 0
        // 캐릭터 진화(evolution_level>0) 1명
        case "step_up_2_character_evolve": return charList.some(([, c]) => c.evolutionLevel > 0) ? 1 : 0
        // EX퀘 1장 클리어
        case "step_up_2_ex_1_clear": return anyClearedInSection(questProgress, QuestCategory.EX) ? 1 : 0
        // Lv50 데일리 → 데일리 클리어로 근사
        case "step_up_2_daily_exp_mana_50": return anyClearedInSection(questProgress, QuestCategory.DAILY_EXP_MANA_EVENT) ? 1 : 0
        // 보스 배틀 3회 클리어: BOSS_BATTLE 섹션 finished 개수 (target=3)
        case "step_up_2_boss_battle": return clearedCountInSection(questProgress, QuestCategory.BOSS_BATTLE)
        // 중급 보스: 보스 클리어 존재로 근사
        case "step_up_2_boss_battle_middle": return anyClearedInSection(questProgress, QuestCategory.BOSS_BATTLE) ? 1 : 0
        // 흔들리는 미궁 붕괴역: 데일리/전용 섹션 클리어 존재로 근사
        case "step_up_2_yuragi_hokai": return anyClearedInSection(questProgress, QuestCategory.DAILY_EXP_MANA_EVENT) ? 1 : 0
        // ── 중급편 (13xxx) ──────────────────────────────────────────────
        case "step_up_3_main_5_clear": return mainChapterCleared(questProgress, 5) ? 1 : 0
        case "step_up_3_main_6_clear": return mainChapterCleared(questProgress, 6) ? 1 : 0
        // 캐릭터 6명 진화 (target=6): evolution_level>0 캐릭터 수
        case "step_up_3_character_evolve": return charList.filter(([, c]) => c.evolutionLevel > 0).length
        // 오버리밋(over_limit_step>0) 1명
        case "step_up_3_character_over_limit": return charList.some(([, c]) => c.overLimitStep > 0) ? 1 : 0
        case "step_up_3_daily_exp_mana_60": return anyClearedInSection(questProgress, QuestCategory.DAILY_EXP_MANA_EVENT) ? 1 : 0
        case "step_up_3_yuragi_hokai_50": return anyClearedInSection(questProgress, QuestCategory.DAILY_EXP_MANA_EVENT) ? 1 : 0
        case "step_up_3_yuragi_yugen": return anyClearedInSection(questProgress, QuestCategory.DAILY_EXP_MANA_EVENT) ? 1 : 0
        case "step_up_3_boss_battle_upper": return anyClearedInSection(questProgress, QuestCategory.BOSS_BATTLE) ? 1 : 0
        // 메인 6장까지 S+ COMPLETE: 1~6장 각각 finished 인지 (근사: 6장 클리어면 충족)
        case "step_up_3_main_1_6_complete": return mainChapterCleared(questProgress, 6) ? 1 : 0
        // ── 상급편 (14xxx) ──────────────────────────────────────────────
        case "step_up_4_main_7_clear": return mainChapterCleared(questProgress, 7) ? 1 : 0
        case "step_up_4_main_1_6_ex_complete": return anyClearedInSection(questProgress, QuestCategory.EX) ? 1 : 0
        case "step_up_4_boss_battle_upper_plus": return anyClearedInSection(questProgress, QuestCategory.BOSS_BATTLE) ? 1 : 0
        // 장비 Lv5까지 각성: level>=5 인 장비 보유
        case "step_up_4_equipment_upgrade_to_5": return Object.values(equipment).some(e => e.level >= 5) ? 1 : 0
        // 인연의 증표 획득: bond token 보유 수
        case "step_up_4_obtain_bond_token": return ctx.bondTokenCount > 0 ? 1 : 0
        // 무라쿠모(무라쿠모=특정 캐릭터) 동료: 캐릭터 보유 판정 — 캐릭터 id 미확정이라 0(추적필요)
        case "step_up_4_join_katana_ghost": return 0
        case "step_up_4_yuragi_hokai_60": return anyClearedInSection(questProgress, QuestCategory.DAILY_EXP_MANA_EVENT) ? 1 : 0
        case "step_up_4_yuragi_hokai_70": return anyClearedInSection(questProgress, QuestCategory.DAILY_EXP_MANA_EVENT) ? 1 : 0
        // ── 순수 UI/일회성 액션 (서버가 상태로 추적 안 함 → 판정 불가, 0) ──────
        case "step_up_1_character_episode": // 캐릭터 에피소드 열람
        case "step_up_1_mana_board": // 마나 보드 어빌리티 해방
        case "step_up_1_inject_exp": // Lv강화 경험치 주입
        case "step_up_2_treasure_shop": // 특별 상품 구입
        case "step_up_3_boss_coin_exchange_equip": // 보스 코인 교환
        case "step_up_4_try_practice": // 연습 배틀 도전
        case "step_up_4_use_ability_soul": // 어빌리티 소울 장착
            return 0
        // all_clear(모두 클리어)는 여기서 계산하지 않는다 — 같은 스텝의 다른 미션 완료수에
        // 의존하므로 호출부(serializeAllActiveMissionList)에서 2-pass 로 집계한다.
        default:
            return 0
    }
}

// all_clear 패턴인지 (입문/초급/중급/상급편 "모두 클리어하기").
export function isStepUpAllClear(pattern: string): boolean {
    return /^step_up_\d+_all_clear$/.test(pattern)
}
