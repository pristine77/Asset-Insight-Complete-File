import type { Metadata } from "next";
import DeviceAccessView from "@/components/auth/DeviceAccessView";

export const metadata: Metadata = {
  title: "Device access",
  description: "Register this browser installation for secure Asset Insight access.",
  robots: { index: false, follow: false },
};

export default function DeviceAccessPage() {
  return <DeviceAccessView />;
}
