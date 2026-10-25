"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuthContext } from "@/context/AuthContext";

export default function ProtectedRoute({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, sessionPresent, loading, loggingOut, deviceAccess } =
    useAuthContext();

  useEffect(() => {
    if (loading || loggingOut || user) return;
    if (deviceAccess) {
      router.replace(`/device-access?next=${encodeURIComponent(`${pathname || "/workspaces"}${window.location.search}`)}`);
      return;
    }
    if (!sessionPresent) {
      const loginUrl = `/login?next=${encodeURIComponent(`${pathname || "/workspaces"}${window.location.search}`)}`;
      router.replace(loginUrl);
    }
  }, [
    deviceAccess,
    loading,
    loggingOut,
    pathname,
    router,
    sessionPresent,
    user,
  ]);

  if (
    deviceAccess || loading || loggingOut || !user
  ) {
    return (
      <div className="app-page" role="status" aria-live="polite">
        <div className="app-surface app-section" style={{ minHeight: 180 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="app-spinner" aria-hidden />
            <span className="app-muted">
              {deviceAccess ? "Opening device access…" : loading || sessionPresent ? "Opening workspace…" : "Opening sign in…"}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
