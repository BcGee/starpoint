// Handles mission progress (regular / daily / event missions).
//
// STAGE 1 (implemented here): surface the mission LIST so daily/regular missions
// actually appear in-game. For each category the client asks about, we return the
// missions from mission.json that are currently active (server-time within the
// mission's [startDate, endDate] window) with progress_value 0 / stage 1.
//
// Why this is enough to make missions show: the WF client computes mission progress
// locally and pushes it via update_mission_progress; get_mission_progress only needs
// to enumerate which missions exist. Returning an empty list (the old stub) made the
// client show "no missions".
//
// STAGE 2 (TODO, needs a DB table players_mission_progress): persist the progress
// values the client pushes in update_mission_progress and echo them back here, then
// grant mission_reward when a mission completes. Left out for now because it requires
// a schema migration; see scripts/convert_mission.py + assets/mission.json for the
// master data that a full implementation would build on.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/wdfpData";
import { generateDataHeaders, getServerDate } from "../../utils";
import * as path from "path";
// Load mission master data at runtime via an indirect require so tsc doesn't pull
// the large nested JSON into its type graph (a direct import of assets/mission.json
// fails module resolution here, unlike the assets imported from src/lib/assets.ts).
// Resolve relative to the compiled file location (out/routes/api → ../../assets).
const missionsData = require(path.join(__dirname, "..", "..", "..", "assets", "mission.json"));

// mission.json shape:
//   { "1": {...regular}, "2": {...daily}, "3": {...event_mission},
//     "eventMissions": { "<event_id>": { "<mission_id>": {category:4, eventId, stage, pattern, desc, target, startDate, endDate } } } }
// category 1 = regular, 2 = daily, 3 = event_mission (startdash 등),
// eventMissions = collect_item_event / campaign missions the client opens by event_id (client category 4).
type MissionDef = {
    category: number;
    eventId?: number;
    stage?: number;
    pattern: string;
    desc: string;
    target: number;
    startDate: string | null;
    endDate: string | null;
};
const missionsByCategory = missionsData as unknown as Record<string, Record<string, MissionDef>>;
// event_id -> { mission_id -> MissionDef }
const eventMissions = (missionsData.eventMissions || {}) as Record<string, Record<string, MissionDef>>;

// Parses a "YYYY-MM-DD HH:MM:SS" master-data timestamp (UTC) to epoch ms, or null.
function parseMasterDate(s: string | null): number | null {
    if (!s) return null;
    const iso = s.replace(" ", "T") + "Z";
    const t = Date.parse(iso);
    return isNaN(t) ? null : t;
}

// Returns the active mission ids for a category at the given server time.
// Regular missions (category 1) have null start/end → always active.
function activeMissionsForCategory(category: number, nowMs: number): string[] {
    const table = missionsByCategory[String(category)];
    if (!table) return [];
    const ids: string[] = [];
    for (const [id, def] of Object.entries(table)) {
        const start = parseMasterDate(def.startDate);
        const end = parseMasterDate(def.endDate);
        if (start !== null && nowMs < start) continue;
        if (end !== null && nowMs > end) continue;
        ids.push(id);
    }
    return ids;
}

// Returns the active missions for a specific event_id (client category 4 = 캠페인/이벤트 미션),
// time-filtered. Each entry carries its own stage (multi-stage campaign missions).
// The client opens an event and asks for {category:4, event_id:X}; it shows ONLY that event's
// missions, so serving the wrong event's list = "세부미션 0개". This is why 서머/캠페인 미션이 안 떴다.
function activeEventMissions(eventId: number, nowMs: number): { id: number, stage: number }[] {
    const table = eventMissions[String(eventId)];
    if (!table) return [];
    const out: { id: number, stage: number }[] = [];
    for (const [id, def] of Object.entries(table)) {
        const start = parseMasterDate(def.startDate);
        const end = parseMasterDate(def.endDate);
        if (start !== null && nowMs < start) continue;
        if (end !== null && nowMs > end) continue;
        const nid = Number(id);
        if (isNaN(nid)) continue;
        out.push({ id: nid, stage: def.stage ?? 1 })
    }
    return out;
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_mission_progress", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetMissionProgressBody

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // Build the mission progress list for the categories the client asked about
        // (falls back to categories 1/2/3 if none specified). Progress starts at 0;
        // the client pushes real progress via update_mission_progress.
        const nowMs = getServerDate().getTime()
        console.log("[MISSION/get] body=" + JSON.stringify(body) + " nowMs=" + nowMs)

        const missionProgressList: {
            mission_category: number,
            mission_id: number,
            progress_value: number,
            stage: number
        }[] = []

        // 클라 미션 category(요청) → 서버 데이터 매핑.
        //   클라 1 = regular         → mission.json["1"]
        //   클라 2 = daily           → mission.json["2"]
        //   클라 4 = event(+event_id) → eventMissions[event_id]  (★ event_id 로 정확히 그 이벤트의 미션만)
        // ★ 핵심 수정: 예전엔 event_id 를 무시하고 event_mission(cat3, summer 등) 전체를 반환했다.
        //   클라는 자기가 연 이벤트(event_id)의 미션만 화면에 필터하므로, event_id 가 안 맞는
        //   미션을 받으면 "세부미션 0개"로 뜬다(서머/캠페인 미션 안보임의 진짜 원인).
        //   이제 event_id 가 있으면 eventMissions[event_id] 에서 그 이벤트 미션만 정확히 서빙한다.
        //   응답 mission_category 는 클라가 준 값 그대로 echo, stage 는 미션 정의의 stage 사용.
        const clientToServerCategory: Record<number, number> = { 1: 1, 2: 2 }

        const entries = (body.category_list && body.category_list.length)
            ? body.category_list
            : [{ category: 1 }, { category: 2 }]

        for (const entry of entries) {
            const clientCat = entry.category
            const eventId = (entry as { event_id?: number }).event_id

            if (eventId !== undefined && eventId !== null && !isNaN(Number(eventId))) {
                // 이벤트/캠페인 미션: event_id 로 정확히 매칭
                for (const { id, stage } of activeEventMissions(Number(eventId), nowMs)) {
                    missionProgressList.push({
                        mission_category: clientCat,
                        mission_id: id,
                        progress_value: 0,
                        stage: stage
                    })
                }
                continue
            }

            // event_id 없는 요청(regular/daily): category 매핑으로 서빙
            const serverCat = clientToServerCategory[clientCat]
            if (serverCat === undefined) continue
            for (const id of activeMissionsForCategory(serverCat, nowMs)) {
                const nid = Number(id)
                if (isNaN(nid)) continue
                missionProgressList.push({
                    mission_category: clientCat,
                    mission_id: nid,
                    progress_value: 0,
                    stage: 1
                })
            }
        }
        console.log("[MISSION/get] served=" + missionProgressList.length + " for " + JSON.stringify(entries))

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "mission_progress_list": missionProgressList,
                "mail_arrived": false
            }
        })
    })

    fastify.post("/update_mission_progress", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UpdateMissionProgressBody

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // STAGE 2 TODO: persist body.mission_param_list progress to
        // players_mission_progress and grant mission_reward on completion.
        // For now we accept the push and return empty (no reward), which keeps the
        // client happy without a DB migration.
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "mission_info": [],
                "degree_list": [],
                "mail_arrived": false
            }
        })
    })
}

interface GetMissionProgressBody {
    api_count: number,
    viewer_id: number,
    category_list: {
        category: number,
        // 이벤트/캠페인 미션 요청 시 클라가 채워 보냄 (예: {category:4, event_id:10010}).
        event_id?: number
    }[]
}

interface UpdateMissionProgressBody {
    viewer_id: number,
    api_count: number,
    mission_param_list: {
        progress_value: number,
        mission_pattern: string
    }
}

export default routes;
