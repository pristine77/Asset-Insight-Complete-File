import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return proxyJsonWithAdminAuth(
    request,
    `/api/admin/preview-reports/drafts/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}
