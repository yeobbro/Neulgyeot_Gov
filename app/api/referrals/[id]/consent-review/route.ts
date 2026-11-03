import { parseBody, route } from "@/lib/server/http";
import { consentReviewBody, reviewConsentCategory } from "@/lib/server/services/referrals";

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => reviewConsentCategory(tx, actor, params.id, await parseBody(req, consentReviewBody)));
