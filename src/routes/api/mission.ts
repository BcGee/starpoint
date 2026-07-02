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
const missions = missionsData as Record<string, Record<string, MissionDef>>;

// mission.json shape: { "<category>": { "<mission_id>": { category, pattern, desc,
// target, startDate, endDate } } }. category 1 = regular, 2 = daily, 3 = event.
type MissionDef = {
    category: number;
    pattern: string;
    desc: string;
    target: number;
    startDate: string | null;
    endDate: string | null;
};
const missionsByCategory = missions as unknown as Record<string, Record<string, MissionDef>>;

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
        const requestedCategories = (body.category_list && body.category_list.length)
            ? body.category_list.map((c) => c.category)
            : [1, 2, 3]
        console.log("[MISSION/get] body=" + JSON.stringify(body) + " nowMs=" + nowMs + " reqCats=" + JSON.stringify(requestedCategories))

        const missionProgressList: {
            mission_category: number,
            mission_id: number,
            progress_value: number,
            stage: number
        }[] = []

        for (const category of requestedCategories) {
            for (const id of activeMissionsForCategory(category, nowMs)) {
                const nid = Number(id)
                if (isNaN(nid)) continue
                missionProgressList.push({
                    mission_category: category,
                    mission_id: nid,
                    progress_value: 0,
                    stage: 1
                })
            }
        }

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
        category: number
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
