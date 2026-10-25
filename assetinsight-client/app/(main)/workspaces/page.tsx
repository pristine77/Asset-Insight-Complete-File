import type { Metadata } from "next";
import WorkspacePicker from "@/components/app-shell/WorkspacePicker";

export const metadata: Metadata = { title: "Choose workspace | Asset Insight" };
export default function WorkspacesPage() { return <WorkspacePicker />; }
