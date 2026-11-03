import { parseQuery, route } from "@/lib/server/http";
import { listReferrals, referralListQuery } from "@/lib/server/services/referrals";

export const GET = route(async ({ req, tx, actor }) => listReferrals(tx, actor, parseQuery(req, referralListQuery)));
