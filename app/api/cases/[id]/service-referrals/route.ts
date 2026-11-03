import { parseBody, route } from "@/lib/server/http";
import { createServiceReferral, listServiceReferralsForCase, serviceReferralCreateBody } from "@/lib/server/services/providers";

export const GET = route<{ id: string }>(async ({ params, tx, actor }) => listServiceReferralsForCase(tx, actor, params.id));
export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => createServiceReferral(tx, actor, params.id, await parseBody(req, serviceReferralCreateBody)));
