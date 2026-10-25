import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; updateId: string }> }
) {
  const { id, updateId } = await params;
  const body = await request.json().catch(() => ({}));

  return proxyJsonWithAdminAuth(request, `/api/crm/admin/leads/${id}/updates/${updateId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; updateId: string }> }
) {
  const { id, updateId } = await params;
  return proxyJsonWithAdminAuth(request, `/api/crm/admin/leads/${id}/updates/${updateId}`, {
    method: "DELETE",
  });
}
