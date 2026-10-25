import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";
import YouTubeSettings from "@/app/components/youtube/YouTubeSettings";
import { requireOperationalAdminPage } from "@/lib/requireOperationalAdminPage";
export const metadata = { title: "YouTube Videos | Asset Insight Admin", referrer: "no-referrer" as const };
export default async function Page() {
  await requireOperationalAdminPage();
  return <AdminNavbarV2><YouTubeSettings /></AdminNavbarV2>;
}
