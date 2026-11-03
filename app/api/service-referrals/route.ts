import { route } from "@/lib/server/http";
import { listServiceReferrals } from "@/lib/server/services/providers";

export const GET = route(async ({ req, tx, actor }) => ({ data: await listServiceReferrals(tx, actor, new URL(req.url).searchParams.get("status") ?? undefined) }));
