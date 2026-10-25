import { Suspense } from "react";
import type { Metadata } from "next";
import CrmWorkspace from "@/components/crm/CrmWorkspace";

export const metadata: Metadata = { title: "CRM Tasks" };
export default function CrmTasksPage() {
  return <Suspense fallback={<div className="app-page" role="status">Loading CRM tasks…</div>}><CrmWorkspace page="tasks" /></Suspense>;
}
