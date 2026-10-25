import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const { batchId } = await params;
  return proxyJsonWithAdminAuth(request, `/api/crm/admin/import-files/${batchId}`, {
    method: "DELETE",
  });
}
