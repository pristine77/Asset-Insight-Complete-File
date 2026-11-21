import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

/** How many leads a move would take; changes nothing (Move Leads window). */
export async function POST(request: NextRequest) {
  const body = await request.text();
  return proxyJsonWithAdminAuth(request, `/api/crm/admin/leads/move/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
