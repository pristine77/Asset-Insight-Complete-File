import { requireSuperadminPage } from "@/lib/requireSuperadminPage";

export default async function ApkManagerLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  await requireSuperadminPage();
  return children;
}
