import { parseQuery, route } from "@/lib/server/http";
import { exportReportCsv, reportQuery } from "@/lib/server/services/insights";

export const GET = route(async ({ req, tx, actor }) => {
  const q = parseQuery(req, reportQuery);
  const csv = await exportReportCsv(tx, actor, q);
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="report_${q.from}_${q.to}.csv"`, "cache-control": "no-store" } });
});
