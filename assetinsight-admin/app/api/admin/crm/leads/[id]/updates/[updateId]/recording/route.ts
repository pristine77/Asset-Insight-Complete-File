import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; updateId: string }> }
) {
  const { id, updateId } = await params;
  return proxyJsonWithAdminAuth(request, `/api/crm/admin/leads/${id}/updates/${updateId}/recording`, {
    method: "DELETE",
  });
}
