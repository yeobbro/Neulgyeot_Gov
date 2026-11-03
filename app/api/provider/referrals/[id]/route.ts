import { route } from "@/lib/server/http";
import { providerReferralDetail } from "@/lib/server/services/providers";

export const GET = route<{ id: string }>(async ({ params, tx, actor }) => providerReferralDetail(tx, actor, params.id));
