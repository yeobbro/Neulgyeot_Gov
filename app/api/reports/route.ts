import { parseBody, parseQuery, route } from "@/lib/server/http";
import { buildReport, reportQuery, saveReportSnapshot } from "@/lib/server/services/insights";

export const GET = route(async ({ req, tx, actor }) => buildReport(tx, actor, parseQuery(req, reportQuery)));
export const POST = route(async ({ req, tx, actor }) => saveReportSnapshot(tx, actor, await parseBody(req, reportQuery)));
