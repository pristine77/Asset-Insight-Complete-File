import type { NextRequest } from "next/server";
import { proxyStreamWithAdminAuth } from "@/lib/adminProxy";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  return proxyStreamWithAdminAuth(
    request,
    `/api/admin/reports/${encodeURIComponent(id)}/proposal-valuation/export`
  );
}
