import SalvagePreviewWorkspace from "@/components/reports/SalvagePreviewWorkspace";

export default async function SalvagePreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SalvagePreviewWorkspace key={id} reportId={id} />;
}
