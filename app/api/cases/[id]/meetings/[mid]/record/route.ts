import { parseBody, route } from "@/lib/server/http";
import { meetingRecordBody, recordMeeting } from "@/lib/server/services/plans";

export const POST = route<{ id: string; mid: string }>(async ({ req, params, tx, actor }) => recordMeeting(tx, actor, params.id, params.mid, await parseBody(req, meetingRecordBody)));
