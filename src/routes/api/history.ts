// Handles the item/reward acquisition history log.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";

interface ReceiveBody {
    page: number,
    viewer_id: number
}

const routes = async (fastify: FastifyInstance) => {
    // Returns the player's paginated acquisition history. Starpoint does not record
    // a history ledger, so we return an empty, zero-count list. The client renders
    // this as an empty history screen.
    fastify.post("/receive", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBody

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
                "total_count": 0,
                "history": []
            }
        })
    })
}

export default routes;
