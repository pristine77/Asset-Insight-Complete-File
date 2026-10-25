import { Suspense } from "react";
import type { Metadata } from "next";
import CrmWorkspace from "@/components/crm/CrmWorkspace";

export const metadata: Metadata = { title: "CRM Coverage" };
export default function CrmCoveragePage() {
  return <Suspense fallback={<div className="app-page" role="status">Loading CRM coverage…</div>}><CrmWorkspace page="coverage" /></Suspense>;
}
