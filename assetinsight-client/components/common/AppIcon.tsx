import {
  Building2,
  CarFront,
  ChartNoAxesCombined,
  CircleDollarSign,
  PackageSearch,
  type LucideIcon,
} from "lucide-react";

type IconName = "building" | "car" | "chart" | "dollar" | "package";

const icons: Record<IconName, LucideIcon> = {
  building: Building2,
  car: CarFront,
  chart: ChartNoAxesCombined,
  dollar: CircleDollarSign,
  package: PackageSearch,
};

export function AppIcon({
  name,
  size = 44,
  accent = "var(--app-accent)",
  className,
}: {
  name: IconName;
  size?: number;
  accent?: string;
  className?: string;
}) {
  const Icon = icons[name];
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        display: "grid",
        flex: "0 0 auto",
        placeItems: "center",
        border: "1px solid var(--app-border)",
        borderRadius: 8,
        background: "var(--app-panel-alt)",
        color: accent,
      }}
    >
      <Icon size={Math.round(size * 0.48)} strokeWidth={1.8} aria-hidden />
    </span>
  );
}
