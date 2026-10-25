import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sourceBatchId: string }> }
) {
  const { sourceBatchId } = await params;
  return proxyJsonWithAdminAuth(
    request,
    `/api/crm/admin/assignments-by-upload/${encodeURIComponent(sourceBatchId)}/reassign`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
    }
  );
}
