import SalvageProgressWorkspace from "@/components/reports/SalvageProgressWorkspace";

export default async function SalvageStatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SalvageProgressWorkspace key={id} reportId={id} />;
}
