import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

/** The latest lead moves, newest first (Move Leads window). */
export async function GET(request: NextRequest) {
  const qs = new URL(request.url).search;
  return proxyJsonWithAdminAuth(request, `/api/crm/admin/leads/moves${qs}`, { method: "GET" });
}
