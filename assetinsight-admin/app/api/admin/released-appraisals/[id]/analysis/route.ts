import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  return proxyJsonWithAdminAuth(
    request,
    `/api/admin/released-appraisals/${encodeURIComponent(id)}/analysis`
  );
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  return proxyJsonWithAdminAuth(
    request,
    `/api/admin/released-appraisals/${encodeURIComponent(id)}/analysis`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
    }
  );
}
