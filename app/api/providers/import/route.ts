import { z } from "zod";
import { invalid } from "@/lib/server/errors";
import { parseBody, route } from "@/lib/server/http";
import { importGangnamFacilityCsv, previewGangnamFacilityCsv } from "@/lib/server/services/provider-import";

const bodySchema = z.object({
  csv: z.string().min(20).max(2_000_000),
  mode: z.enum(["preview", "import"]),
}).strict();

export const POST = route(async ({ req, tx, actor }) => {
  const body = await parseBody(req, bodySchema);
  try {
    if (body.mode === "preview") return { preview: previewGangnamFacilityCsv(body.csv) };
    return await importGangnamFacilityCsv(tx, actor, body.csv);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : "CSV를 처리하지 못했습니다.");
  }
});
