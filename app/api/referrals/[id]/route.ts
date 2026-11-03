import { route } from "@/lib/server/http";
import { getReferral } from "@/lib/server/services/referrals";

export const GET = route<{ id: string }>(async ({ params, tx, actor }) => getReferral(tx, actor, params.id));
