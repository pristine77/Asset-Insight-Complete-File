import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { parseReportApprovalRequest } from "@/lib/reportApprovalUiPolicy";

async function readApprovalBody(request: NextRequest): Promise<unknown> {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32000) {
        await reader.cancel();
        throw new Error("Approval details are too large.");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  return text.trim() ? JSON.parse(text) : {};
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body;
  try {
    body = parseReportApprovalRequest(await readApprovalBody(request));
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "Invalid approval details." }, { status: 400 });
  }
  return proxyJsonWithAdminAuth(request, `/api/admin/reports/${encodeURIComponent(id)}/approve`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
