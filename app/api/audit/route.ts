import { parseQuery, route } from "@/lib/server/http";
import { auditQuery, listAudit } from "@/lib/server/services/insights";

export const GET = route(async ({ req, tx, actor }) => listAudit(tx, actor, parseQuery(req, auditQuery)));
