import ProposalValuationWorkspace from "@/components/reports/proposal-valuation/ProposalValuationWorkspace";

export default async function ProposalValuationWorkspacePage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  return <ProposalValuationWorkspace reportId={reportId} />;
}
