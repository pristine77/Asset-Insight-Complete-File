import { type NextRequest } from "next/server";
import { proxyMultipartWithAdminAuth } from "@/lib/adminProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function POST(request: NextRequest) {
  return proxyMultipartWithAdminAuth(request, "/api/crm/admin/leads/import");
}
