import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; fieldId: string }> }
) {
  const { id, fieldId } = await params;
  const body = await request.text();
  return proxyJsonWithAdminAuth(request, `/api/admin/spec-sheet/categories/${id}/fields/${fieldId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; fieldId: string }> }
) {
  const { id, fieldId } = await params;
  return proxyJsonWithAdminAuth(request, `/api/admin/spec-sheet/categories/${id}/fields/${fieldId}`, {
    method: "DELETE",
  });
}
