import { parseBody, route } from "@/lib/server/http";
import { locationConsentBody, registerLocationConsent } from "@/lib/server/services/control";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => registerLocationConsent(tx, actor, params.id, await parseBody(req, locationConsentBody)));
