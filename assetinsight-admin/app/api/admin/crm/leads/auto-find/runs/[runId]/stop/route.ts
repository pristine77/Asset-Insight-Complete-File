import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  return proxyJsonWithAdminAuth(
    request,
    `/api/crm/admin/leads/auto-find/runs/${encodeURIComponent(runId)}/stop`,
    { method: "POST" }
  );
}
