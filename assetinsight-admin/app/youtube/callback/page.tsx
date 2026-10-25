import YouTubeCallback from "@/app/components/youtube/YouTubeCallback";
import { requireOperationalAdminPage } from "@/lib/requireOperationalAdminPage";
export const metadata = { title: "Connect YouTube | Asset Insight Admin", referrer: "no-referrer" as const, robots: { index: false, follow: false } };
export default async function Page() {
  await requireOperationalAdminPage();
  return <YouTubeCallback />;
}
