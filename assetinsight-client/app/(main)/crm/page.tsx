import { Suspense } from "react";
import type { Metadata } from "next";
import CrmWorkspace from "@/components/crm/CrmWorkspace";

export const metadata: Metadata = { title: "CRM Dashboard" };

export default function CrmPage() {
  return <Suspense fallback={<div className="app-page" role="status">Loading CRM…</div>}><CrmWorkspace /></Suspense>;
}
