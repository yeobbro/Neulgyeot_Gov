import { parseBody, route } from "@/lib/server/http";
import { generateBody, generateDraft, listDrafts } from "@/lib/server/services/ai";

export const POST = route(async ({ req, tx, actor }) => generateDraft(tx, actor, await parseBody(req, generateBody)));
export const GET = route(async ({ req, tx, actor }) => {
  const u = new URL(req.url).searchParams;
  return { data: await listDrafts(tx, actor, { caseId: u.get("caseId") ?? undefined, referralId: u.get("referralId") ?? undefined }) };
});
