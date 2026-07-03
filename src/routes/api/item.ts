// item/sell + item/use_item routes.
//
// CLIENT CONTRACT (SWF decompile — ItemSellRealRemote / ItemUseItemRealRemote):
//   POST /item/sell      { item_id, sell_number }
//     - Client successHandler = ItemSellRemoteInput.Finished(itemId, sellNumber) — it uses its
//       OWN local itemId/sellNumber and IGNORES the response body. So the server just needs to:
//       decrement the item, grant mana (WF sells items for MANA), and return a valid 200.
//   POST /item/use_item  { items: [{ id, number }] }
//     - Client successHandler = ItemUseItemRemoteInput.Finished (no args) — IGNORES the body too.
//       Server: consume the item(s) and apply the effect (stamina potions restore stamina).
//     - Client error codes it special-cases: 2057 (out of period), 2102 (stamina already max).
//
// Item master (assets/item.json, converted by scripts/convert_items.py):
//   { "<id>": { pattern, salePrice(=mana per unit), useKind(2=stamina potion), useValue(stamina), rarity, maxStack } }

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession, getAccountPlayers, getPlayerSync, getPlayerItemSync, updatePlayerItemSync, updatePlayerSync } from "../../data/wdfpData";
import { generateDataHeaders, getServerTime } from "../../utils";
import * as path from "path";

// item master loaded at runtime (indirect require so tsc doesn't pull the big JSON into its graph).
const itemData = require(path.join(__dirname, "..", "..", "..", "assets", "item.json")) as Record<string, {
    pattern: string, salePrice: number, useKind: number, useValue: number, rarity: number, maxStack: number
}>;

// WF base stamina cap. The server has no rank-based stamina max, so we use a generous flat cap
// to avoid stamina growing unbounded from potion use.
const STAMINA_CAP = 999;

async function resolvePlayerId(viewerId: number): Promise<number | null> {
    if (!viewerId || isNaN(viewerId)) return null;
    const session = await getSession(viewerId.toString());
    if (!session) return null;
    const playerIds = await getAccountPlayers(session.accountId);
    const playerId = playerIds[0];
    return isNaN(playerId) ? null : playerId;
}

const routes = async (fastify: FastifyInstance) => {
    // Sell items for mana. Body: { item_id, sell_number }.
    fastify.post("/sell", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { item_id: number, sell_number: number, viewer_id: number, api_count: number };
        const viewerId = body.viewer_id;
        const playerId = await resolvePlayerId(viewerId);
        if (playerId === null) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." });

        const itemId = Number(body.item_id);
        const sellNumber = Number(body.sell_number);
        console.log("[ITEM/sell] item_id=" + itemId + " sell_number=" + sellNumber);
        if (isNaN(itemId) || isNaN(sellNumber) || sellNumber <= 0) {
            return reply.status(400).send({ "error": "Bad Request", "message": "Invalid sell parameters." });
        }

        const player = getPlayerSync(playerId);
        if (player === null) return reply.status(500).send({ "error": "Internal Server Error", "message": "Player not found." });

        const owned = getPlayerItemSync(playerId, itemId) ?? 0;
        const sellQty = Math.min(sellNumber, owned); // never sell more than owned
        const def = itemData[String(itemId)];
        const unitPrice = def ? def.salePrice : 0;
        const manaGained = unitPrice * sellQty;

        // decrement item, grant mana
        if (sellQty > 0) updatePlayerItemSync(playerId, itemId, owned - sellQty);
        const newMana = player.freeMana + manaGained;
        updatePlayerSync({ id: playerId, freeMana: newMana });

        const itemList: Record<string, number> = {};
        itemList[String(itemId)] = owned - sellQty;

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": {
                    "free_mana": newMana,
                    "exp_pool": player.expPool,
                    "exp_pooled_time": getServerTime(player.expPooledTime)
                },
                "item_list": itemList,
                "mail_arrived": false
            }
        });
    });

    // Use consumable items. Body: { items: [{ id, number }] }. Stamina potions restore stamina.
    fastify.post("/use_item", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { items: { id: number, number: number }[], viewer_id: number, api_count: number };
        const viewerId = body.viewer_id;
        const playerId = await resolvePlayerId(viewerId);
        if (playerId === null) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid viewer id." });

        const items = Array.isArray(body.items) ? body.items : [];
        console.log("[ITEM/use_item] items=" + JSON.stringify(items));

        const player = getPlayerSync(playerId);
        if (player === null) return reply.status(500).send({ "error": "Internal Server Error", "message": "Player not found." });

        let stamina = player.stamina;
        const itemList: Record<string, number> = {};

        for (const entry of items) {
            const itemId = Number(entry.id);
            const useCount = Number(entry.number);
            if (isNaN(itemId) || isNaN(useCount) || useCount <= 0) continue;

            const owned = getPlayerItemSync(playerId, itemId) ?? 0;
            const consume = Math.min(useCount, owned);
            if (consume <= 0) continue;

            const def = itemData[String(itemId)];
            // stamina potion (useKind 2): restore useValue stamina per item used
            if (def && def.useKind === 2 && def.useValue > 0) {
                stamina = Math.min(STAMINA_CAP, stamina + def.useValue * consume);
            }
            updatePlayerItemSync(playerId, itemId, owned - consume);
            itemList[String(itemId)] = owned - consume;
        }

        updatePlayerSync({ id: playerId, stamina: stamina });

        reply.header("content-type", "application/x-msgpack");
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": {
                    "stamina": stamina,
                    "stamina_heal_time": getServerTime(player.staminaHealTime)
                },
                "item_list": itemList,
                "mail_arrived": false
            }
        });
    });
};

export default routes;
