import { type NextRequest } from "next/server";
import { proxyStreamWithAdminAuth } from "@/lib/adminProxy";

type RouteContext = {
  params: Promise<{ id: string; kind: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { id, kind } = await context.params;
  return proxyStreamWithAdminAuth(
    request,
    `/api/admin/released-appraisals/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(kind)}/download`
  );
}
