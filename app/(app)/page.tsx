import { redirect } from "next/navigation";
import { withPage } from "@/lib/server/page";

export default async function Home() {
  const roles = await withPage(async (_tx, a) => a.roles);
  if (roles.includes("municipal_admin") || roles.includes("case_manager")) redirect("/dashboard");
  if (roles.includes("service_provider")) redirect("/provider");
  redirect("/audit");
}
