import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.toString();
  return proxyJsonWithAdminAuth(
    request,
    `/api/admin/preview-reports${query ? `?${query}` : ""}`,
    { method: "GET" }
  );
}
