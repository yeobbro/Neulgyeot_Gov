import { route } from "@/lib/server/http";
import { exportCasesCsv } from "@/lib/server/services/insights";

export const GET = route(async ({ tx, actor }) => {
  const csv = await exportCasesCsv(tx, actor);
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="cases.csv"', "cache-control": "no-store" } });
});
