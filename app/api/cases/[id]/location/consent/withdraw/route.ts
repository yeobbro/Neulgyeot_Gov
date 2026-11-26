import { route } from "@/lib/server/http";
import { withdrawLocationConsent } from "@/lib/server/services/control";

export const POST = route<{ id: string }>(async ({ params, tx, actor }) => withdrawLocationConsent(tx, actor, params.id));
