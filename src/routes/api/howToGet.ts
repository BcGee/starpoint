// Handles the "how to get this item" guidance screen.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";

interface GetListBody {
    viewer_id: number,
    item_id: number
}

const routes = async (fastify: FastifyInstance) => {
    // Returns the list of acquisition sources (box gachas / shop sales) for a given
    // item. This screen is purely informational. Starpoint does not maintain an
    // item-source index, so we return empty source lists; the client renders the
    // screen with no listed sources.
    fastify.post("/get_list", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetListBody

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

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "box_gacha_id_list": [],
                "unselected_lineup_shop_sales_list": [],
                "shop_sales_list": []
            }
        })
    })
}

export default routes;
