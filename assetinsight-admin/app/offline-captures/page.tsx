import { redirect } from "next/navigation";

export const metadata = { title: "Offline Captures | Asset Insight Admin" };

export default async function Page() {
  redirect("/report-activity?tab=captures");
}
