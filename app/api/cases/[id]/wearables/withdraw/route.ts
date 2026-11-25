import { route } from "@/lib/server/http";
import { withdrawConsent } from "@/lib/server/services/wearables";

export const POST = route<{ id: string }>(async ({ params, tx, actor }) => withdrawConsent(tx, actor, params.id));
