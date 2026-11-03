import { route } from "@/lib/server/http";
import { getIdentity } from "@/lib/server/services/cases";

export const GET = route<{ id: string }>(async ({ params, tx, actor }) => ({ identity: await getIdentity(tx, actor, params.id) }));
