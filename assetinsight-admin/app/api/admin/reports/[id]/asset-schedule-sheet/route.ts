import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.text();
  return proxyJsonWithAdminAuth(request, `/api/admin/reports/${id}/asset-schedule-sheet`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
}
