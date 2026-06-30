// Handles the multiplayer lounge listing.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";

interface GetListBody {
    use_case: number,
    viewer_id: number
}

const routes = async (fastify: FastifyInstance) => {
    // Returns the list of open multiplayer lounges. Starpoint does not implement
    // multiplayer, so the lounge list is always empty.
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
                "lounge_list": []
            }
        })
    })
}

export default routes;
