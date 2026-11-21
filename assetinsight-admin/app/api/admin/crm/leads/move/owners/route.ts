import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

/** Everyone leads can be moved from or to, with their lead counts (Move Leads window). */
export async function GET(request: NextRequest) {
  return proxyJsonWithAdminAuth(request, `/api/crm/admin/leads/move/owners`, { method: "GET" });
}
