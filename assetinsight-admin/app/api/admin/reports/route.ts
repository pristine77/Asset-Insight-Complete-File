import { NextResponse, type NextRequest } from "next/server";
import { SERVER_URL } from "@/lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const token = request.cookies.get("cv_admin")?.value;
  if (!token) return NextResponse.json({ message: "Not authenticated" }, { status: 401 });

  const url = new URL(request.url);
  const qs = url.search; // includes leading ? if any

  const res = await fetch(`${SERVER_URL}/api/admin/reports${qs}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
