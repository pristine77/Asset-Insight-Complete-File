import { NextResponse, type NextRequest } from "next/server";
import { SERVER_URL } from "@/lib/api";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const token = request.cookies.get("cv_admin")?.value;
  if (!token) return NextResponse.json({ message: "Not authenticated" }, { status: 401 });

  const res = await fetch(`${SERVER_URL}/api/admin/reports/${id}/spec-pdf`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    redirect: "manual",
  });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (location) {
      return NextResponse.redirect(location, { status: 302 });
    }
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({ message: "Failed to generate CR" }));
    return NextResponse.json(data, { status: res.status });
  }

  const headers = new Headers();
  headers.set("content-type", res.headers.get("content-type") || "application/pdf");
  const disposition = res.headers.get("content-disposition");
  if (disposition) headers.set("content-disposition", disposition);
  headers.set("cache-control", res.headers.get("cache-control") || "private, max-age=30");

  return new NextResponse(res.body, { status: 200, headers });
}
