import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  return proxyJsonWithAdminAuth(
    request,
    `/api/crm/admin/leads/auto-find/runs/${encodeURIComponent(runId)}`,
    { method: "GET" }
  );
}
