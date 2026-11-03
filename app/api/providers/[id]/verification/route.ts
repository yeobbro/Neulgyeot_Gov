import { z } from "zod";
import { invalid } from "@/lib/server/errors";
import { parseBody, route } from "@/lib/server/http";
import { setProviderVerification } from "@/lib/server/services/provider-import";

const bodySchema = z.object({ verified: z.boolean() }).strict();

export const POST = route<{ id: string }>(async ({ req, params, tx, actor }) => {
  const body = await parseBody(req, bodySchema);
  try {
    return await setProviderVerification(tx, actor, params.id, body.verified);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : "기관 검증 상태를 변경하지 못했습니다.");
  }
});
