import { parseBody, route } from "@/lib/server/http";
import { createMeeting, meetingCreateBody } from "@/lib/server/services/plans";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => createMeeting(tx, actor, params.id, await parseBody(req, meetingCreateBody)));
