import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  return proxyJsonWithAdminAuth(request, `/api/crm/admin/leads/import-jobs/${encodeURIComponent(jobId)}`, {
    method: "GET",
  });
}
