import { AuthProvider } from "@/context/AuthContext";

export default function DeviceAccessLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthProvider>{children}</AuthProvider>;
}
