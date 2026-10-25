"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Ban,
  CalendarDays,
  CheckCircle2,
  Clock3,
  HardDrive,
  Laptop,
  LockKeyhole,
  Mail,
  Phone,
  RefreshCw,
  ShieldCheck,
  UserRound,
  Video,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAuthContext } from "@/context/AuthContext";
import {
  buildBasicDeviceContext,
  CameraVerificationError,
  type BrowserDeviceContext,
} from "@/lib/device-access";
import AuthLightShell, {
  AUTH_PRIMARY_BUTTON_CLASS,
  AUTH_SECONDARY_BUTTON_CLASS,
  AuthNotice,
  AuthSpinner,
} from "@/components/auth/AuthLightShell";
import BrandLockup from "@/components/auth/BrandLockup";
import { safeAppNextPath } from "@/lib/workspace";

function formatDate(value?: string) {
  if (!value) return "Today";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Today"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function formatStorage(context: BrowserDeviceContext | null) {
  const storage = context?.metadata.storage as
    | { availableBytes?: number; quotaBytes?: number }
    | undefined;
  if (typeof storage?.availableBytes !== "number") return "Browser quota available";
  const gb = storage.availableBytes / 1024 ** 3;
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB browser quota available`;
}

function valueText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export default function DeviceAccessView() {
  const router = useRouter();
  const {
    user,
    loading,
    deviceAccess,
    registerDevice,
    refreshDeviceStatus,
    rerequestDevice,
    logout,
  } = useAuthContext();
  const [context, setContext] = useState<BrowserDeviceContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  useEffect(() => {
    void buildBasicDeviceContext().then(setContext).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (loading) return;
    if (user && !deviceAccess) {
      router.replace(safeAppNextPath(new URLSearchParams(window.location.search).get("next")));
    } else if (!user && !deviceAccess) {
      router.replace("/login");
    }
  }, [deviceAccess, loading, router, user]);

  useEffect(() => {
    if (!deviceAccess || !["pending", "rerequest_pending"].includes(deviceAccess.authState)) {
      return;
    }
    let active = true;
    const poll = async () => {
      if (!active || document.visibilityState !== "visible" || !navigator.onLine) return;
      try {
        await refreshDeviceStatus();
        if (active) setManualError(null);
      } catch (error) {
        if (active) {
          setManualError((error as Error).message || "Unable to refresh approval status.");
        }
      }
    };
    const interval = window.setInterval(poll, 10_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [deviceAccess, refreshDeviceStatus]);

  const state = deviceAccess?.authState || "registration_required";
  const support = deviceAccess?.supportContact;
  const isRestricted = state === "rejected" || state === "revoked";
  const isBlocked = state === "ip_blocked";
  const pending = state === "pending" || state === "rerequest_pending";

  const presentation = useMemo(() => {
    if (state === "registration_required") {
      return {
        leftTitle: "Device approval required.",
        leftDescription:
          "This browser has not been approved for your account. Verify its camera details to send a request to your administrator.",
        title: "Allow camera access to continue",
        description:
          "Camera permission is required so your administrator can verify this device. If no camera is installed, we’ll record that automatically.",
        icon: <LockKeyhole className="h-7 w-7" strokeWidth={1.8} />,
        features: ["Browser verification", "Administrator review", "Device-bound access"],
      };
    }
    if (pending) {
      return {
        leftTitle: state === "rerequest_pending" ? "Review requested again." : "Approval request sent.",
        leftDescription:
          "This browser stays locked while an administrator reviews its device, camera, storage, and IP details.",
        title:
          state === "rerequest_pending"
            ? "Your new request is under review"
            : "Waiting for administrator approval",
        description:
          "You can leave this page open. Access unlocks automatically when the request is approved.",
        icon: <Clock3 className="h-7 w-7" strokeWidth={1.8} />,
        features: ["Request received", "Automatic status checks", "Secure approval handoff"],
      };
    }
    if (isBlocked) {
      return {
        leftTitle: "Access blocked for this network.",
        leftDescription:
          "An administrator blocked this IP address for your account. Device re-requests are unavailable until the address is unblocked.",
        title: "This IP address is blocked",
        description: "Contact your administrator using the support details below.",
        icon: <Ban className="h-7 w-7 text-[var(--app-danger)]" strokeWidth={1.8} />,
        features: ["Account-specific protection", "Administrator controls", "Support contact available"],
      };
    }
    return {
      leftTitle: state === "revoked" ? "Device access revoked." : "Device request rejected.",
      leftDescription:
        state === "revoked"
          ? "Your administrator removed this browser installation’s access. Review the details and request another review if appropriate."
          : "Your administrator did not approve this browser installation. Review the details and contact support if you need help.",
      title: state === "revoked" ? "Access was revoked" : "Access was not approved",
      description: "You can request another review or contact your administrator.",
      icon: <XCircle className="h-7 w-7 text-[var(--app-danger)]" strokeWidth={1.8} />,
      features: ["Clear status details", "Administrator notes", "Review requests"],
    };
  }, [isBlocked, pending, state]);

  async function onRegister() {
    setBusy(true);
    setManualError(null);
    try {
      await registerDevice();
    } catch (error) {
      setManualError(
        error instanceof CameraVerificationError
          ? error.message
          : (error as Error).message || "Unable to submit this device request."
      );
    } finally {
      setBusy(false);
    }
  }

  async function onRefresh() {
    setBusy(true);
    setManualError(null);
    try {
      await refreshDeviceStatus();
    } catch (error) {
      setManualError((error as Error).message || "Unable to refresh approval status.");
    } finally {
      setBusy(false);
    }
  }

  async function onRerequest() {
    setBusy(true);
    setManualError(null);
    try {
      await rerequestDevice();
    } catch (error: unknown) {
      const responseMessage =
        typeof error === "object" &&
        error !== null &&
        "response" in error &&
        typeof error.response === "object" &&
        error.response !== null &&
        "data" in error.response &&
        typeof error.response.data === "object" &&
        error.response.data !== null &&
        "message" in error.response.data &&
        typeof error.response.data.message === "string"
          ? error.response.data.message
          : null;
      setManualError(
        responseMessage ||
          (error instanceof Error ? error.message : "Unable to request another review.")
      );
    } finally {
      setBusy(false);
    }
  }

  async function onSignOut() {
    setBusy(true);
    await logout();
    router.replace("/login");
  }

  if (loading || (!deviceAccess && !user)) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--app-bg)] text-[var(--app-text)]">
        <div className="flex flex-col items-center gap-6">
          <BrandLockup compact />
          <AuthSpinner className="h-8 w-8 text-[var(--app-accent)]" />
          <p className="text-sm text-[var(--app-text-muted)]">Loading device access...</p>
        </div>
      </main>
    );
  }

  const browser = context?.metadata.browser as Record<string, unknown> | undefined;
  const os = context?.metadata.os as Record<string, unknown> | undefined;
  const deviceLabel =
    deviceAccess?.device?.displayName ||
    (context
      ? `${valueText(browser?.name, "Browser")} on ${valueText(os?.name, "this device")}`
      : "Browser installation");

  return (
    <AuthLightShell
      title={presentation.leftTitle}
      description={presentation.leftDescription}
      features={presentation.features}
    >
      <section aria-labelledby="device-access-heading">
        <p className="text-sm font-semibold uppercase tracking-[0.08em] text-[var(--app-accent)]">
          Secure access
        </p>
        <div className="mt-5 grid h-12 w-12 place-items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-accent)]">
          {presentation.icon}
        </div>
        <h2
          id="device-access-heading"
          className="mt-5 text-4xl font-semibold tracking-[-0.04em] text-[var(--app-text)] sm:text-5xl"
        >
          {presentation.title}
        </h2>
        <p className="mt-4 max-w-xl text-base leading-7 text-[var(--app-text-muted)]">
          {presentation.description}
        </p>

        {state === "registration_required" ? (
          <dl className="mt-8 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] text-sm">
            <DeviceDetail label="Device" value={context ? `${valueText(os?.name, "Browser")} ${context.formFactor}` : "Detecting…"} />
            <DeviceDetail label="Browser" value={context ? `${valueText(browser?.name, "Browser")} ${valueText(browser?.version, "")}`.trim() : "Detecting…"} />
            <DeviceDetail label="Storage" value={formatStorage(context)} last />
          </dl>
        ) : null}

        {pending ? (
          <div className="mt-8 rounded-lg border border-[var(--app-warning-border)] bg-[var(--app-warning-soft)] p-4">
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--app-warning)]" />
              <span className="font-semibold text-[var(--app-text)]">
                {state === "rerequest_pending" ? "Re-request pending" : "Request pending"}
              </span>
            </div>
            <p className="mt-2 text-sm text-[var(--app-text-muted)]">
              Requested {formatDate(deviceAccess?.device?.requestedAt)} · Checked automatically every 10 seconds.
            </p>
          </div>
        ) : null}

        {isRestricted || isBlocked ? (
          <div className="mt-8 space-y-5">
            <div>
              <p className="text-sm font-medium text-[var(--app-text)]">Status</p>
              <span className="mt-2 inline-flex rounded-md border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] px-3 py-1.5 text-sm font-semibold capitalize text-[var(--app-danger)]">
                {state.replaceAll("_", " ")}
              </span>
            </div>
            <div className="grid gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4 text-sm text-[var(--app-text-muted)] sm:grid-cols-3">
              <DeviceSummary icon={<Laptop className="h-4 w-4" />} text={deviceLabel} />
              <DeviceSummary icon={<CalendarDays className="h-4 w-4" />} text={`Requested ${formatDate(deviceAccess?.device?.requestedAt)}`} />
              <DeviceSummary icon={<HardDrive className="h-4 w-4" />} text={formatStorage(context)} />
            </div>
            {deviceAccess?.reason ? (
              <div>
                <p className="text-sm font-medium text-[var(--app-text)]">Administrator note</p>
                <p className="mt-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)] px-4 py-3 text-sm text-[var(--app-text-muted)]">
                  {deviceAccess.reason}
                </p>
              </div>
            ) : null}
            {support ? (
              <div className="border-t border-[var(--app-border)] pt-5">
                <p className="text-sm font-medium text-[var(--app-text)]">Need help?</p>
                <div className="mt-3 space-y-2.5 text-sm text-[var(--app-text-muted)]">
                  {support.name ? <DeviceSummary icon={<UserRound className="h-4 w-4" />} text={support.name} /> : null}
                  {support.email ? (
                    <a className="flex items-center gap-3 hover:text-[var(--app-accent)]" href={`mailto:${support.email}`}>
                      <Mail className="h-4 w-4" />
                      <span>{support.email}</span>
                    </a>
                  ) : null}
                  {support.phone ? (
                    <a className="flex items-center gap-3 hover:text-[var(--app-accent)]" href={`tel:${support.phone}`}>
                      <Phone className="h-4 w-4" />
                      <span>{support.phone}</span>
                    </a>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {manualError ? (
          <div className="mt-6">
            <AuthNotice tone="error">
              <div className="flex items-start gap-3">
                <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <p>{manualError}</p>
                  {state === "registration_required" ? (
                    <button type="button" className="mt-1 font-semibold underline underline-offset-4" onClick={() => void onRegister()}>
                      Try again
                    </button>
                  ) : null}
                </div>
              </div>
            </AuthNotice>
          </div>
        ) : null}

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          {state === "registration_required" ? (
            <button type="button" disabled={busy} onClick={() => void onRegister()} className={`flex-1 ${AUTH_PRIMARY_BUTTON_CLASS}`}>
              {busy ? <AuthSpinner /> : <Video className="h-5 w-5" />}
              {busy ? "Checking camera..." : "Allow camera access"}
            </button>
          ) : null}
          {pending ? (
            <button type="button" disabled={busy} onClick={() => void onRefresh()} className={`flex-1 ${AUTH_PRIMARY_BUTTON_CLASS}`}>
              {busy ? <AuthSpinner /> : <RefreshCw className="h-5 w-5" />}
              {busy ? "Checking..." : "Check status now"}
            </button>
          ) : null}
          {isRestricted ? (
            <button type="button" disabled={busy} onClick={() => void onRerequest()} className={`flex-1 ${AUTH_PRIMARY_BUTTON_CLASS}`}>
              {busy ? <AuthSpinner /> : <CheckCircle2 className="h-5 w-5" />}
              {busy ? "Sending request..." : "Request again"}
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={() => void onSignOut()} className={AUTH_SECONDARY_BUTTON_CLASS}>
            Sign out
          </button>
        </div>

        {state === "registration_required" ? (
          <div className="mt-6 flex items-start gap-3 border-t border-[var(--app-border)] pt-5 text-xs leading-5 text-[var(--app-text-muted)]">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
            <p>
              Camera details are collected for access review. No photo or video is saved, and raw browser media-device IDs are never retained. See our{" "}
              <Link href="/privacy" className="font-semibold underline underline-offset-2 hover:text-[var(--app-text)]">
                privacy notice
              </Link>
              .
            </p>
          </div>
        ) : null}
        {isRestricted ? <p className="mt-6 text-sm text-[var(--app-text-muted)]">Re-requests are limited to 5 in a rolling 24-hour period.</p> : null}
        {isBlocked ? <p className="mt-6 text-sm text-[var(--app-text-muted)]">IP blocks are exact-address and specific to your account.</p> : null}
      </section>
    </AuthLightShell>
  );
}

function DeviceDetail({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return (
    <div className={`grid grid-cols-[96px_1fr] gap-4 px-4 py-3 ${last ? "" : "border-b border-[var(--app-border)]"}`}>
      <dt className="text-[var(--app-text-muted)]">{label}</dt>
      <dd className="font-medium text-[var(--app-text)]">{value}</dd>
    </div>
  );
}

function DeviceSummary({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-[var(--app-accent)]">{icon}</span>
      <span className="truncate">{text}</span>
    </div>
  );
}
