import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return proxyJsonWithAdminAuth(
    request,
    `/api/admin/reports/${id}/excel-condition-reports`
  );
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.text();
  return proxyJsonWithAdminAuth(
    request,
    `/api/admin/reports/${id}/excel-condition-reports`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    }
  );
}

