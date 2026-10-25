import { RefreshCw } from "lucide-react";

export default function ProposalValuationWorkspaceLoading() {
  return (
    <div className="grid h-[calc(100dvh-56px)] place-items-center lg:h-[calc(100dvh-60px)]" role="status">
      <div className="text-center">
        <RefreshCw className="mx-auto size-7 animate-spin text-[var(--app-accent)]" />
        <p className="mt-3 text-sm font-semibold text-[var(--app-text)]">
          Loading Proposal Valuation…
        </p>
      </div>
    </div>
  );
}
