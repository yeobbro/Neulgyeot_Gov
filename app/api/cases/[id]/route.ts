import { route } from "@/lib/server/http";
import { getCase } from "@/lib/server/services/cases";

export const GET = route<{ id: string }>(async ({ params, tx, actor }) => getCase(tx, actor, params.id));
