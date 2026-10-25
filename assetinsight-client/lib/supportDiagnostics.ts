export type SafeSupportDiagnostics = {
  occurredAt: string;
  route: string;
  appVersion?: string;
  buildNumber?: string;
  platform?: string;
  osVersion?: string;
  deviceModel?: string;
  screen?: string;
};

/**
 * Collects a deliberately small, allow-listed browser snapshot for support.
 * Query strings, URL fragments, cookies, storage, form values, authentication
 * state, and network payloads are intentionally excluded because they may
 * contain customer data or credentials.
 */
export function collectSafeSupportDiagnostics(): SafeSupportDiagnostics {
  const diagnostics: SafeSupportDiagnostics = {
    occurredAt: new Date().toISOString(),
    route:
      typeof window === "undefined"
        ? "server"
        : window.location.pathname.slice(0, 300),
    platform: "web",
  };

  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION?.trim().slice(0, 80);
  const buildNumber = process.env.NEXT_PUBLIC_BUILD_NUMBER?.trim().slice(0, 80);
  if (appVersion) diagnostics.appVersion = appVersion;
  if (buildNumber) diagnostics.buildNumber = buildNumber;
  if (typeof window === "undefined") return diagnostics;

  diagnostics.osVersion =
    window.navigator.platform?.trim().slice(0, 120) || undefined;
  diagnostics.deviceModel =
    window.navigator.userAgent?.trim().slice(0, 160) || undefined;
  diagnostics.screen = `${Math.max(0, Math.round(window.innerWidth))}x${Math.max(
    0,
    Math.round(window.innerHeight)
  )} CSS px @ ${Math.max(1, window.devicePixelRatio || 1)}x`.slice(0, 200);

  return diagnostics;
}
