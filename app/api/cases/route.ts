import { parseBody, parseQuery, route } from "@/lib/server/http";
import { caseListQuery, createCase, listCases, newCaseBody } from "@/lib/server/services/cases";

export const GET = route(async ({ req, tx, actor }) => listCases(tx, actor, parseQuery(req, caseListQuery)));
export const POST = route(async ({ req, tx, actor }) => createCase(tx, actor, await parseBody(req, newCaseBody)));
