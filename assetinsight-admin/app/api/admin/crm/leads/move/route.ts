import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

/** Moves an owner's matching leads to an agent or a vacant pool (Move Leads window). */
export async function POST(request: NextRequest) {
  const body = await request.text();
  return proxyJsonWithAdminAuth(request, `/api/crm/admin/leads/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
