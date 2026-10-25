import AppShell from "@/components/app-shell/AppShell";
import ProtectedRoute from "@/components/auth/ProtectedRoute";
import { DataProvider } from "@/components/providers/DataProvider";
import { Toaster } from "@/components/ui/toast";
import { AuthProvider } from "@/context/AuthContext";

export default function MainLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <AuthProvider>
      <DataProvider>
        <ProtectedRoute>
          <AppShell>{children}</AppShell>
        </ProtectedRoute>
        <Toaster />
      </DataProvider>
    </AuthProvider>
  );
}
