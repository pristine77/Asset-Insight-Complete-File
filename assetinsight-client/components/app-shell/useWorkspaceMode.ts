"use client";

import { useEffect, useState } from "react";
import { routeWorkspace, workspaceStorageKey, type WorkspaceMode } from "@/lib/workspace";

export function useWorkspaceMode(pathname: string, ownerId: string, crmEnabled: boolean) {
  const explicit = routeWorkspace(pathname);
  const [hint, setHint] = useState<{ ownerId: string; mode: WorkspaceMode } | null>(null);
  useEffect(() => {
    let mode: WorkspaceMode = explicit || "listings";
    try {
      if (!explicit && crmEnabled && sessionStorage.getItem(workspaceStorageKey(ownerId)) === "crm") mode = "crm";
      if (!crmEnabled) mode = "listings";
      sessionStorage.setItem(workspaceStorageKey(ownerId), mode);
    } catch {
      // Storage may be disabled. Explicit routes and server permissions still apply.
    }
    setHint({ ownerId, mode });
  }, [explicit, ownerId, crmEnabled]);
  if (!crmEnabled) return "listings";
  return explicit || (hint?.ownerId === ownerId ? hint.mode : null);
}
