import { route } from "@/lib/server/http";
import { listProviders } from "@/lib/server/services/providers";

export const GET = route(async ({ req, tx, actor }) => {
  const u = new URL(req.url).searchParams;
  return { data: await listProviders(tx, actor, { serviceType: u.get("serviceType") ?? undefined, region: u.get("region") ?? undefined }) };
});
