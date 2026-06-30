// Handles the friend/follow system.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";

interface ListsBody {
    viewer_id: number
}

const routes = async (fastify: FastifyInstance) => {
    // Returns the list of users that the player is following / followed by.
    // On a fresh account, this is empty. Starpoint does not implement social features,
    // so we always report an empty follow list.
    fastify.post("/lists", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ListsBody

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
                "follow_info": [],
                "followed_count": 0
            }
        })
    })
}

export default routes;
