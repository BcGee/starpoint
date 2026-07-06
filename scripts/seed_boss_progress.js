#!/usr/bin/env node
/**
 * seed_boss_progress.js — 보스 배틀 난이도 해금용 quest_progress 시드
 *
 * 배경 (원인):
 *   보스 난이도 해금은 100% 클라이언트가 CDN 마스터데이터(boss_battle_quest)로 판정한다.
 *   각 난이도 노드에는 선행 퀘스트(prereq, 행의 [11] 필드)가 박혀 있고, 클라는
 *   /load 의 quest_progress 에서 그 prereq 가 해당 category(section) 안에서
 *   is_cleared(=finished) 인지 확인해서 다음 난이도를 연다.
 *   (SWF: getInsufficientQuestIdsNeedToBeClearedToClear → getQuestProgressByCategory(category)
 *          → h[questId].is_cleared)
 *
 *   서버 /finish 는 클리어를 category 별 section 에 정확히 기록하므로 "실제로 깨면" 자동으로 열린다.
 *   높은 난이도가 안 열리는 건 버그가 아니라 선행 퀘스트(주로 메인 스토리) 미클리어 때문이다.
 *
 * 이 스크립트는 그 선행 체인을 quest_progress 에 시드해서, 이미 강한 계정이
 *   보스 난이도를 실제 플레이로 뚫지 않고도 열 수 있게 한다.
 *
 * 사용법 (EC2, starpoint 루트에서):
 *   node scripts/seed_boss_progress.js --player 1 [--mode full|main|upto=<questId>] [--dry] [--db <path>]
 *
 *   --mode full        (기본) 모든 보스 난이도(99) + 필요한 메인퀘 prereq 를 finished 로 시드 → 전 보스 해금
 *   --mode main        메인퀘 prereq 만 시드 (보스 1난이도들이 열리고, 2난이도부터는 실제 플레이로)
 *   --mode upto=<qid>  해당 메인퀘까지 깬 것으로 시드 (그 지점까지 열리는 보스만 해금)
 *   --dry              DB 를 건드리지 않고 무엇을 넣을지 출력만
 *
 * boss_battle_quest.json 은 서버 assets 가 아니라 추출된 CDN 원본(scripts/in_extracted/quest/)을
 * 쓴다. prereq([11]) 는 추출본에만 있고 서버 assets/boss_battle_quest.json 에는 없기 때문.
 */

const path = require('path')
const fs = require('fs')

// ---- args ----
const args = process.argv.slice(2)
function getArg(name, def) {
    const i = args.indexOf('--' + name)
    if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1]
    return def
}
const hasFlag = (name) => args.includes('--' + name)

const PLAYER_ID = Number(getArg('player', '1'))
const DRY = hasFlag('dry')
let MODE = getArg('mode', 'full')
let UPTO = null
if (MODE.startsWith('upto=')) { UPTO = MODE.slice(5); MODE = 'upto' }

const DB_PATH = getArg('db', path.join(process.cwd(), '.database', 'wdfp_data.db'))
const EXTRACTED = getArg('extracted', path.join(process.cwd(), 'scripts', 'in_extracted', 'quest', 'boss_battle_quest.json'))

// section 번호 (QuestCategory enum: EMPTY=0, MAIN=1, BOSS_BATTLE=2)
const SECTION_MAIN = 1
const SECTION_BOSS = 2

// ---- load boss unlock graph (extracted CDN master) ----
if (!fs.existsSync(EXTRACTED)) {
    console.error('추출된 boss_battle_quest.json 이 없음:', EXTRACTED)
    console.error('먼저 scripts/extract_master.js 로 CDN 마스터를 추출해라.')
    process.exit(1)
}
const bqRaw = JSON.parse(fs.readFileSync(EXTRACTED, 'utf8'))
const bq = bqRaw['1'] // group 1

// 모든 보스 난이도 노드 수집: {quest, diff, prereq}
const nodes = []
for (const nodeId of Object.keys(bq)) {
    for (const dk of Object.keys(bq[nodeId])) {
        const r = bq[nodeId][dk]
        nodes.push({
            quest: String(r[0]),
            diff: Number(r[1]),
            prereq: (r[11] === '(None)' || r[11] === '' || r[11] == null) ? null : String(r[11]),
            node: nodeId
        })
    }
}

const bossQuestIds = new Set(nodes.map(n => n.quest))

// prereq 를 boss(다른 난이도) vs main 으로 분류
function prereqSection(qid) {
    return bossQuestIds.has(qid) ? SECTION_BOSS : SECTION_MAIN
}

// 시드할 (section, questId) 집합 계산
const toSeed = new Map() // key `${section}:${quest}` -> {section, quest}
function add(section, quest) { toSeed.set(`${section}:${quest}`, { section, quest: String(quest) }) }

if (MODE === 'full') {
    // 모든 보스 난이도 finished + 그 prereq(메인퀘 포함) finished
    for (const n of nodes) {
        add(SECTION_BOSS, n.quest)
        if (n.prereq) add(prereqSection(n.prereq), n.prereq)
    }
} else if (MODE === 'main') {
    // 메인퀘 prereq 만 (보스 1난이도 오픈; 나머지는 실제 플레이)
    for (const n of nodes) {
        if (n.prereq && prereqSection(n.prereq) === SECTION_MAIN) add(SECTION_MAIN, n.prereq)
    }
} else if (MODE === 'upto') {
    // UPTO 메인퀘까지 깬 것으로: 그 이하 메인퀘 prereq + 그로 인해 열리는 보스 체인
    // 메인퀘 prereq 중 UPTO 이하만 넣고, 보스 체인은 도달 가능한 것만 반복 확장
    const mainPrereqs = [...new Set(nodes.filter(n => n.prereq && prereqSection(n.prereq) === SECTION_MAIN).map(n => n.prereq))]
    for (const mq of mainPrereqs) if (mq <= UPTO) add(SECTION_MAIN, mq)
    // fixpoint: prereq 가 이미 시드된 보스는 열 수 있음 → 그 보스도 클리어로 간주
    let changed = true
    while (changed) {
        changed = false
        for (const n of nodes) {
            const key = `${SECTION_BOSS}:${n.quest}`
            if (toSeed.has(key)) continue
            const p = n.prereq
            const ok = !p || toSeed.has(`${prereqSection(p)}:${p}`)
            if (ok) { add(SECTION_BOSS, n.quest); changed = true }
        }
    }
} else {
    console.error('알 수 없는 mode:', MODE)
    process.exit(1)
}

const seedList = [...toSeed.values()].sort((a, b) => a.section - b.section || a.quest.localeCompare(b.quest))
const bySection = seedList.reduce((m, x) => { (m[x.section] = m[x.section] || []).push(x.quest); return m }, {})

console.log(`[seed_boss_progress] player=${PLAYER_ID} mode=${MODE}${UPTO ? '=' + UPTO : ''} dry=${DRY}`)
console.log(`  DB: ${DB_PATH}`)
console.log(`  시드 대상: ${seedList.length}개`)
for (const sec of Object.keys(bySection)) {
    const label = sec === '1' ? 'MAIN' : sec === '2' ? 'BOSS' : 'section' + sec
    console.log(`   - section ${sec} (${label}): ${bySection[sec].length}개  [${bySection[sec].slice(0, 8).join(', ')}${bySection[sec].length > 8 ? ', ...' : ''}]`)
}

if (DRY) {
    console.log('  --dry: DB 미변경. 실제 적용하려면 --dry 빼고 다시 실행.')
    process.exit(0)
}

// ---- apply to DB ----
const Database = require('better-sqlite3')
const db = new Database(DB_PATH)

// 기존 진행 보존: 이미 있으면 finished=1 로 업데이트, 없으면 insert. best_time/rank/score 는 건드리지 않음.
const existsStmt = db.prepare('SELECT 1 FROM players_quest_progress WHERE player_id=? AND section=? AND quest_id=?')
const insertStmt = db.prepare('INSERT INTO players_quest_progress (section, quest_id, finished, high_score, clear_rank, best_elapsed_time_ms, player_id) VALUES (?, ?, 1, NULL, NULL, NULL, ?)')
const updateStmt = db.prepare('UPDATE players_quest_progress SET finished=1 WHERE player_id=? AND section=? AND quest_id=?')

let inserted = 0, updated = 0
const tx = db.transaction(() => {
    for (const { section, quest } of seedList) {
        const q = Number(quest)
        if (existsStmt.get(PLAYER_ID, section, q)) { updateStmt.run(PLAYER_ID, section, q); updated++ }
        else { insertStmt.run(section, q, PLAYER_ID); inserted++ }
    }
})
tx()

console.log(`  적용 완료: insert ${inserted}, update ${updated}`)
console.log('  다음 /load 시 클라가 quest_progress 를 다시 읽어 보스 난이도가 열린다.')
db.close()
