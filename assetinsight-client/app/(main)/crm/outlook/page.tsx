import { Suspense } from "react";
import type { Metadata } from "next";
import CrmWorkspace from "@/components/crm/CrmWorkspace";

export const metadata: Metadata = { title: "CRM Outlook Calendar" };
export default function CrmOutlookPage() {
  return <Suspense fallback={<div className="app-page" role="status">Loading Outlook Calendar…</div>}><CrmWorkspace page="outlook" /></Suspense>;
}
