"use client";

import { BarChart3, LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { Tab, Tabs } from "@mui/material";

type DashboardTab = "overview" | "stats";

export default function DashboardTabs({ active }: { active: DashboardTab }) {
  return (
    <Tabs
      value={active}
      aria-label="Dashboard views"
      sx={{
        minHeight: 38,
        "& .MuiTabs-indicator": { height: 2 },
        "& .MuiTab-root": {
          minHeight: 38,
          minWidth: 0,
          px: 1.75,
          py: 0.75,
          textTransform: "none",
          fontSize: 13,
          fontWeight: 700,
        },
      }}
    >
      <Tab component={Link} href="/dashboard" value="overview" icon={<LayoutDashboard size={16} />} iconPosition="start" label="Overview" />
      <Tab component={Link} href="/stats" value="stats" icon={<BarChart3 size={16} />} iconPosition="start" label="Stats" />
    </Tabs>
  );
}
