import {
  CircleAlert,
  CircleCheck,
  Clock3,
  Eye,
  FilePenLine,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";

export type ReportStatus =
  | "draft"
  | "processing"
  | "preview"
  | "pending_approval"
  | "approved"
  | "declined"
  | "cancelled"
  | "error";

interface StatusBadgeProps {
  status: ReportStatus;
  label?: string;
  className?: string;
}

const statusConfig: Record<
  ReportStatus,
  { label: string; tone: string; icon: LucideIcon }
> = {
  draft: {
    label: "Draft",
    tone: "",
    icon: FilePenLine,
  },
  processing: {
    label: "Processing",
    tone: "app-chip--info",
    icon: LoaderCircle,
  },
  preview: {
    label: "Ready for Review",
    tone: "app-chip--info",
    icon: Eye,
  },
  pending_approval: {
    label: "Awaiting Approval",
    tone: "app-chip--warning",
    icon: Clock3,
  },
  approved: {
    label: "Approved",
    tone: "app-chip--success",
    icon: CircleCheck,
  },
  declined: {
    label: "Declined",
    tone: "app-chip--danger",
    icon: CircleAlert,
  },
  error: {
    label: "Error",
    tone: "app-chip--danger",
    icon: CircleAlert,
  },
  cancelled: { label: "Stopped", tone: "app-chip--warning", icon: CircleAlert },
};

export default function StatusBadge({
  status,
  label,
  className = "",
}: StatusBadgeProps) {
  const config = statusConfig[status] || statusConfig.draft;
  const Icon = config.icon;

  return (
    <span
      className={`app-chip ${config.tone} ${className}`.trim()}
      data-status={status}
    >
      <Icon size={14} strokeWidth={2} aria-hidden />
      {label || config.label}
    </span>
  );
}
