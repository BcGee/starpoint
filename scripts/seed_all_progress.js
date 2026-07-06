#!/usr/bin/env node
/**
 * seed_all_progress.js — player 의 quest_progress 를 전량 finished 로 시드 (진행도 100% 개방)
 *
 * 목적: 오로치/보스/사이드퀘/EX 등 잠긴 콘텐츠를 전부 열어 동작 확인.
 * 대상 카테고리(section = QuestCategory 값):
 *   1=MAIN(main_quest), 2=BOSS_BATTLE(boss_battle_quest), 3=CHARACTER(character_quest), 4=EX(ex_quest)
 *
 * 사용법 (EC2 starpoint 루트):
 *   node scripts/seed_all_progress.js --player 1 [--dry]
 *
 * 안전장치: 실행 전 players_quest_progress 를 자동 백업 (saves/quest_progress_backup_<ts>.json).
 * 되돌리려면 그 json 으로 복원(별도). 기존 레코드는 보존(INSERT OR IGNORE 후 finished=1 UPDATE).
 */
const path = require("path")
const fs = require("fs")

const args = process.argv.slice(2)
const getArg = (n, d) => { const i = args.indexOf("--" + n); return (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) ? args[i + 1] : d }
const DRY = args.includes("--dry")
const PLAYER_ID = Number(getArg("player", "1"))
const BASE = path.dirname(__dirname)
const DB_PATH = getArg("db", path.join(BASE, ".database", "wdfp_data.db"))

// 카테고리 → assets 파일 (flat {quest_id: data})
const CATEGORIES = [
    { section: 1, file: "main_quest.json" },
    { section: 2, file: "boss_battle_quest.json" },
    { section: 3, file: "character_quest.json" },
    { section: 4, file: "ex_quest.json" },
]

function loadQuestIds(file) {
    const p = path.join(BASE, "assets", file)
    if (!fs.existsSync(p)) return []
    const d = JSON.parse(fs.readFileSync(p, "utf8"))
    return Object.keys(d).map(Number).filter(n => !isNaN(n))
}

// 시드 대상 수집
const plan = []
for (const { section, file } of CATEGORIES) {
    const ids = loadQuestIds(file)
    for (const q of ids) plan.push({ section, questId: q })
}

console.log(`[seed_all_progress] player=${PLAYER_ID} dry=${DRY} 총 ${plan.length}개 quest`)
const bySection = plan.reduce((m, x) => { (m[x.section] = m[x.section] || 0, m[x.section]++); return m }, {})
console.log("  section별:", JSON.stringify(bySection), "(1=MAIN 2=BOSS 3=CHAR 4=EX)")

if (DRY) { console.log("  --dry: DB 미변경"); process.exit(0) }

const Database = require("better-sqlite3")
const db = new Database(DB_PATH)

// 백업
const existing = db.prepare("SELECT * FROM players_quest_progress WHERE player_id=?").all(PLAYER_ID)
const backupDir = path.join(BASE, "saves")
fs.mkdirSync(backupDir, { recursive: true })
const ts = new Date().toISOString().replace(/[:.]/g, "-")
const backupPath = path.join(backupDir, `quest_progress_backup_${ts}.json`)
fs.writeFileSync(backupPath, JSON.stringify(existing, null, 1))
console.log(`  백업: ${backupPath} (기존 ${existing.length}행)`)

// clear_rank/high_score/best_elapsed_time_ms 를 NULL 로 두면 클라가 보스/랭크필요 퀘스트 진입 시
// c3212 크래시("클리어 랭크 정보 없음"). 반드시 clear_rank=5(S+), high_score/best_time 안전값 채울 것.
const insertStmt = db.prepare("INSERT OR IGNORE INTO players_quest_progress (section, quest_id, finished, high_score, clear_rank, best_elapsed_time_ms, player_id) VALUES (?, ?, 1, 1, 5, 60000, ?)")
const updateStmt = db.prepare("UPDATE players_quest_progress SET finished=1, clear_rank=COALESCE(clear_rank,5), high_score=COALESCE(high_score,1), best_elapsed_time_ms=COALESCE(best_elapsed_time_ms,60000) WHERE player_id=? AND section=? AND quest_id=?")

let inserted = 0, updated = 0
const tx = db.transaction(() => {
    for (const { section, questId } of plan) {
        const info = insertStmt.run(section, questId, PLAYER_ID)
        if (info.changes > 0) inserted++
        else { updateStmt.run(PLAYER_ID, section, questId); updated++ }
    }
})()

const total = db.prepare("SELECT COUNT(*) c FROM players_quest_progress WHERE player_id=?").get(PLAYER_ID).c
console.log(`  완료: insert ${inserted}, update ${updated}, 현재 총 ${total}행`)
db.close()
