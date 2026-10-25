import {
  Building2,
  CarFront,
  ClipboardCheck,
  FileCheck2,
  FileText,
  LandPlot,
  ListChecks,
  ShieldCheck,
  Tags,
  TimerReset,
} from "lucide-react";

export const navItems = [
  { label: "Workflows", href: "#workflows" },
  { label: "Delivery", href: "#delivery" },
  { label: "Teams", href: "#teams" },
];

export const heroHighlights = [
  "Asset reports",
  "Salvage vehicles",
  "Real estate",
  "Lot listings",
];

export const workflows = [
  {
    title: "Asset reports",
    description: "Create detailed valuations for equipment, vehicles, and more.",
    icon: FileText,
  },
  {
    title: "Salvage vehicles",
    description: "Track damage, photos, and comps to support confident valuations.",
    icon: CarFront,
  },
  {
    title: "Real estate",
    description: "Organize property data, photos, and reports in one place.",
    icon: Building2,
  },
  {
    title: "Lot listings",
    description: "List and value lots, group assets, and prepare for sale.",
    icon: Tags,
  },
];

export const journeySteps = [
  {
    title: "Capture",
    body: "Collect photos, notes, condition details, and values while the work is fresh.",
    icon: ClipboardCheck,
  },
  {
    title: "Review",
    body: "Keep reports, images, lots, and approvals arranged for a reliable handoff.",
    icon: ListChecks,
  },
  {
    title: "Deliver",
    body: "Release polished client files without losing context between teams.",
    icon: FileCheck2,
  },
];

export const results = [
  {
    title: "Cleaner first drafts",
    body: "Photos, values, and notes stay connected from the start.",
    icon: ClipboardCheck,
  },
  {
    title: "Faster handoffs",
    body: "Everyone can see what is ready and what still needs attention.",
    icon: TimerReset,
  },
  {
    title: "Consistent final files",
    body: "Every report package keeps the same professional finish.",
    icon: FileCheck2,
  },
  {
    title: "Controlled delivery",
    body: "The right people prepare, review, and release client work.",
    icon: ShieldCheck,
  },
];

export const industries = [
  { label: "Equipment", icon: ListChecks },
  { label: "Vehicles", icon: CarFront },
  { label: "Property", icon: LandPlot },
];
