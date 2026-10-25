"use client";

import ReleasedAppraisalsWorkspace from "@/app/components/released-appraisals/ReleasedAppraisalsWorkspace";

// The navigation route stays stable while Released Appraisals shares the reliable
// artifact manifest, responsive report layout, and appraisal QA workspace.
export default function AdminApprovals() {
  return <ReleasedAppraisalsWorkspace />;
}
