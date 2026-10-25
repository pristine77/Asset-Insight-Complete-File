"use client";

import ProposalValuationDialog from "../ProposalValuationDialog";

export default function ProposalValuationWorkspace({
  reportId,
}: {
  reportId: string;
}) {
  return (
    <ProposalValuationDialog
      open
      pageMode
      reportId={reportId}
    />
  );
}
