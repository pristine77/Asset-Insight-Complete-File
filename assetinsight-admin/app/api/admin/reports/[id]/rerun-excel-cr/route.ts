import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.text();
  return proxyJsonWithAdminAuth(request, `/api/admin/reports/${id}/rerun-excel-cr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
