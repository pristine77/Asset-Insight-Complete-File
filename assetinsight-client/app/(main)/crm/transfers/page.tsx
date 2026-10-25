import { Suspense } from "react";
import type { Metadata } from "next";
import CrmWorkspace from "@/components/crm/CrmWorkspace";

export const metadata: Metadata = { title: "CRM Transfers" };
export default function CrmTransfersPage() {
  return <Suspense fallback={<div className="app-page" role="status">Loading CRM transfers…</div>}><CrmWorkspace page="transfers" /></Suspense>;
}
