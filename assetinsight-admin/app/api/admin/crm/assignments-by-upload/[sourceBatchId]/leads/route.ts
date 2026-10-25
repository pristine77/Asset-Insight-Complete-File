import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sourceBatchId: string }> }
) {
  const { sourceBatchId } = await params;
  return proxyJsonWithAdminAuth(
    request,
    `/api/crm/admin/assignments-by-upload/${encodeURIComponent(sourceBatchId)}/leads`,
    { method: "GET" }
  );
}
