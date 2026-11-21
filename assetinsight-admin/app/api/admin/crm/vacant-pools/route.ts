import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

/** Creates a vacant pool that holds a territory's leads until someone takes it. */
export async function POST(request: NextRequest) {
  const body = await request.text();
  return proxyJsonWithAdminAuth(request, `/api/crm/admin/vacant-pools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
