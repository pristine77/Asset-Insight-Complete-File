"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  ExternalLink,
  LogOut,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import { UserAvatar } from "@/components/user/UserAvatar";
import { captureAuthSession, isAuthSessionCurrent, type AuthSessionSnapshot } from "@/lib/auth-storage";
import { UserService } from "@/services/user";
import { useAuthContext } from "@/context/AuthContext";
import { useOutlookCalendar } from "@/hooks/useOutlookCalendar";

const OutlookConnectionDialog = dynamic(
  () => import("@/components/outlook/OutlookConnectionDialog"),
  { ssr: false }
);

export default function SettingsPage() {
  const { user, logout, refresh } = useAuthContext();
  const router = useRouter();
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingCv, setUploadingCv] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [isOutlookDialogOpen, setIsOutlookDialogOpen] = useState(false);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const deleteInFlight = useRef(false);
  const deleteSession = useRef<AuthSessionSnapshot | null>(null);
  const deleteOwner = useRef<string | undefined>(undefined);
  const ownerId = user?._id || user?.id;
  const currentOwner = useRef(ownerId);
  currentOwner.current = ownerId;
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const {
    status: outlookStatus,
    loading: outlookLoading,
    busy: outlookBusy,
    error: outlookError,
    fetchStatus: refreshOutlookStatus,
    connect: connectOutlook,
    disconnect: disconnectOutlook,
  } = useOutlookCalendar();
  const [form, setForm] = useState({
    username: (user as any)?.username || "",
    companyName: (user as any)?.companyName || "",
    companyAddress: (user as any)?.companyAddress || "",
    crmAddress: (user as any)?.crmAddress || "",
    contactEmail: (user as any)?.contactEmail || "",
    contactPhone: (user as any)?.contactPhone || "",
  });

  useEffect(() => {
    if (!isEditing) {
      setForm({
        username: (user as any)?.username || "",
        companyName: (user as any)?.companyName || "",
        companyAddress: (user as any)?.companyAddress || "",
        crmAddress: (user as any)?.crmAddress || "",
        contactEmail: (user as any)?.contactEmail || "",
        contactPhone: (user as any)?.contactPhone || "",
      });
    }
  }, [isEditing, user]);

  const needsPassword = (user as any)?.authProvider === "email";
  const memberSince = useMemo(() => {
    const value = (user as any)?.createdAt;
    return value ? new Date(value).toLocaleDateString() : "—";
  }, [user]);
  const lastUpdated = useMemo(() => {
    const value = (user as any)?.updatedAt;
    return value ? new Date(value).toLocaleDateString() : "—";
  }, [user]);

  const handleCvChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    if (!file) {
      setCvFile(null);
      return;
    }
    const validName = file.name.toLowerCase().endsWith(".docx");
    const validType =
      file.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (!validName || !validType) {
      setCvFile(null);
      toast.error("Only .docx files are allowed.");
      return;
    }
    setCvFile(file);
  };

  const handleAvatarChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) {
      toast.error("Choose a JPEG, PNG, or WebP image.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error("Profile pictures must be 8 MB or smaller.");
      return;
    }
    try {
      setUploadingAvatar(true);
      await UserService.uploadAvatar(file);
      await refresh();
      toast.success("Profile picture updated");
    } catch (uploadError: any) {
      toast.error(uploadError?.response?.data?.message || uploadError?.message || "Failed to upload profile picture");
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleDeleteAvatar = async () => {
    try {
      setUploadingAvatar(true);
      await UserService.deleteAvatar();
      await refresh();
      toast.success("Profile picture removed");
    } catch (deleteError: any) {
      toast.error(deleteError?.response?.data?.message || deleteError?.message || "Failed to remove profile picture");
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleUploadCv = async () => {
    if (!cvFile) return;
    try {
      setUploadingCv(true);
      await UserService.uploadCv(cvFile);
      setCvFile(null);
      toast.success("CV uploaded");
      await refresh();
    } catch (uploadError: any) {
      toast.error(
        uploadError?.response?.data?.message ||
          uploadError?.message ||
          "Failed to upload CV"
      );
    } finally {
      setUploadingCv(false);
    }
  };

  const handleDeleteCv = async () => {
    try {
      setUploadingCv(true);
      await UserService.deleteCv();
      toast.success("CV removed");
      await refresh();
    } catch (deleteError: any) {
      toast.error(
        deleteError?.response?.data?.message ||
          deleteError?.message ||
          "Failed to delete CV"
      );
    } finally {
      setUploadingCv(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      await UserService.update({
        username: form.username || undefined,
        companyName: form.companyName || undefined,
        companyAddress: form.companyAddress || undefined,
        crmAddress: form.crmAddress || undefined,
        contactEmail: form.contactEmail || undefined,
        contactPhone: form.contactPhone || undefined,
      });
      toast.success("Profile updated");
      setIsEditing(false);
      await refresh();
    } catch (saveError: any) {
      toast.error(
        saveError?.response?.data?.message ||
          saveError?.message ||
          "Failed to update profile"
      );
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    try {
      setLoggingOut(true);
      await logout();
      router.replace("/welcome");
    } catch {
      setLoggingOut(false);
    }
  };

  const confirmDelete = async () => {
    if (deleteInFlight.current || confirmText !== "DELETE" || (needsPassword && !deletePassword)) return;
    const session = deleteSession.current;
    const owner = deleteOwner.current;
    if (!owner || owner !== currentOwner.current || !session || !isAuthSessionCurrent(session)) {
      setError("Your account session changed. Close this dialog and start again in the current account.");
      return;
    }
    deleteInFlight.current = true;
    setDeleting(true);
    setError(null);
    try {
      await UserService.deleteAccount(needsPassword ? deletePassword : undefined);
    } catch (deleteError: any) {
      const status = deleteError?.response?.status;
      setError(!isAuthSessionCurrent(session) || owner !== currentOwner.current
        ? "Your account session changed. Check the original account's status before trying again."
        : status === 401
          ? "Your password or sign-in session could not be verified. Check your password, or sign in again before retrying."
          : status === 400
            ? "Account deletion could not be confirmed. Check your password and try again, or contact support."
            : status === 403
              ? "This account or device is not permitted to delete the account. Contact support for help."
              : "Account deletion was not confirmed. The request may have been interrupted. Contact support before trying again.");
      setDeleting(false);
      deleteInFlight.current = false;
      return;
    }
    if (!isAuthSessionCurrent(session) || owner !== currentOwner.current) {
      setError("The original account was deleted. Your current account has not been signed out.");
      setDeleting(false);
      deleteInFlight.current = false;
      return;
    }
    setIsDeleteOpen(false);
    setDeletePassword("");
    toast.success("Account deleted. Associated report and media removal is a separate request.");
    // Logout clears this session immediately; a provider failure is not a failed deletion.
    const signOut = logout();
    const signedOutSession = captureAuthSession();
    await signOut.catch(() => {});
    if (isAuthSessionCurrent(signedOutSession)) router.replace("/welcome");
  };

  const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setForm((previous) => ({ ...previous, [name]: value }));
  };

  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (isDeleteOpen && !dialog.open) dialog.showModal();
    if (!isDeleteOpen && dialog.open) dialog.close();
  }, [isDeleteOpen]);

  return (
    <main className="w-full min-w-0 space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--app-accent)]">
          Account
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-[var(--app-text)] md:text-3xl">
          Settings
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--app-text-muted)]">
          Manage profile information, company details, appraiser CV uploads,
          connected services, and account access.
        </p>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,.85fr)]">
        <section className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)]">
          <div className="flex flex-col gap-3 border-b border-[var(--app-border)] px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
            <div>
              <h2 className="font-semibold text-[var(--app-text)]">
                Profile and company details
              </h2>
              <p className="mt-0.5 text-sm text-[var(--app-text-muted)]">
                Details used throughout your authenticated workspace.
              </p>
            </div>
            {isEditing ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  className="min-h-9 rounded-lg border border-[var(--app-border)] px-3 text-sm font-semibold text-[var(--app-text)] hover:bg-[var(--app-panel-alt)]"
                  onClick={() => setIsEditing(false)}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[var(--app-accent)] px-3 text-sm font-semibold text-[var(--app-on-accent)] hover:opacity-90 disabled:opacity-50"
                  onClick={() => void handleSave()}
                  disabled={saving}
                >
                  <Save className="size-4" />
                  {saving ? "Saving..." : "Save changes"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="min-h-9 rounded-lg bg-[var(--app-accent)] px-3 text-sm font-semibold text-[var(--app-on-accent)] hover:opacity-90"
                onClick={() => setIsEditing(true)}
              >
                Edit profile
              </button>
            )}
          </div>

          <div className="p-4 sm:p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="flex items-center gap-3">
                <UserAvatar user={user || { username: "User" }} size={72} />
                <div className="flex flex-wrap gap-2 sm:hidden">
                  <button type="button" className="min-h-9 rounded-lg border border-[var(--app-border)] px-3 text-xs font-semibold text-[var(--app-text)]" onClick={() => avatarInputRef.current?.click()} disabled={uploadingAvatar}>
                    {uploadingAvatar ? "Uploading..." : "Change photo"}
                  </button>
                  {(user as any)?.avatarUrl ? (
                    <button type="button" className="min-h-9 rounded-lg border border-[var(--app-danger-border)] px-3 text-xs font-semibold text-[var(--app-danger)]" onClick={() => void handleDeleteAvatar()} disabled={uploadingAvatar}>
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="min-w-0">
                <p className="break-words font-semibold text-[var(--app-text)]">
                  {(user as any)?.username || user?.email || "Account"}
                </p>
                <p className="mt-0.5 text-xs text-[var(--app-text-muted)] sm:text-sm">
                  Member since {memberSince} · Last updated {lastUpdated}
                </p>
                <div className="mt-3 hidden flex-wrap gap-2 sm:flex">
                  <button type="button" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--app-border)] px-3 text-xs font-semibold text-[var(--app-text)] hover:border-[var(--app-accent)] hover:text-[var(--app-accent)] disabled:opacity-50" onClick={() => avatarInputRef.current?.click()} disabled={uploadingAvatar}>
                    <Upload className="size-3.5" /> {uploadingAvatar ? "Uploading..." : "Upload photo"}
                  </button>
                  {(user as any)?.avatarUrl ? (
                    <button type="button" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--app-danger-border)] px-3 text-xs font-semibold text-[var(--app-danger)] hover:bg-[var(--app-danger-soft)] disabled:opacity-50" onClick={() => void handleDeleteAvatar()} disabled={uploadingAvatar}>
                      <Trash2 className="size-3.5" /> Remove
                    </button>
                  ) : null}
                </div>
              </div>
              <input ref={avatarInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => void handleAvatarChange(event)} />
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {[
                {
                  key: "username",
                  label: "Username",
                  value: form.username,
                  readOnly: !isEditing,
                },
                {
                  key: "email",
                  label: "Email",
                  value: user?.email || "",
                  readOnly: true,
                },
                {
                  key: "companyName",
                  label: "Company name",
                  value: form.companyName,
                  readOnly: !isEditing,
                },
                {
                  key: "companyAddress",
                  label: "Company address",
                  value: form.companyAddress,
                  readOnly: !isEditing,
                },
                ...((user as any)?.isCrmAgent
                  ? [
                      {
                        key: "crmAddress",
                        label: "CRM service address",
                        value: form.crmAddress,
                        readOnly: !isEditing,
                      },
                    ]
                  : []),
                {
                  key: "contactEmail",
                  label: "Contact email",
                  value: form.contactEmail,
                  readOnly: !isEditing,
                },
                {
                  key: "contactPhone",
                  label: "Contact phone",
                  value: form.contactPhone,
                  readOnly: !isEditing,
                },
              ].map((field) => (
                <label key={field.key} className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-[var(--app-text-muted)]">
                    {field.label}
                  </span>
                  <input
                    name={field.key}
                    value={field.value}
                    onChange={onChange}
                    disabled={field.readOnly}
                    className="min-h-10 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent-ring)] disabled:cursor-default disabled:bg-[var(--app-panel-alt)] disabled:text-[var(--app-text-muted)]"
                  />
                </label>
              ))}
            </div>
          </div>
        </section>

        <div className="space-y-5">
          <section className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)]">
            <div className="border-b border-[var(--app-border)] px-4 py-4 sm:px-5">
              <h2 className="font-semibold text-[var(--app-text)]">
                Appraiser CV
              </h2>
              <p className="mt-0.5 text-sm text-[var(--app-text-muted)]">
                Upload a .docx CV to append it to report packages.
              </p>
            </div>
            <div className="space-y-4 p-4 sm:p-5">
              <div className="rounded-lg bg-[var(--app-panel-alt)] p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--app-text-muted)]">
                  Current file
                </p>
                {(user as any)?.cvUrl ? (
                  <>
                    <p className="mt-2 break-words text-sm text-[var(--app-text)]">
                      {(user as any)?.cvFilename || (user as any)?.cvUrl}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <a
                        href={(user as any)?.cvUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--app-border)] px-3 text-xs font-semibold text-[var(--app-text)] hover:border-[var(--app-accent)] hover:text-[var(--app-accent)]"
                      >
                        <ExternalLink className="size-3.5" />
                        View CV
                      </a>
                      <button
                        type="button"
                        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--app-danger-border)] px-3 text-xs font-semibold text-[var(--app-danger)] hover:bg-[var(--app-danger-soft)] disabled:opacity-50"
                        onClick={() => void handleDeleteCv()}
                        disabled={uploadingCv}
                      >
                        <Trash2 className="size-3.5" />
                        Remove
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-[var(--app-text-muted)]">
                    No CV uploaded yet.
                  </p>
                )}
              </div>

              <label className="flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--app-border)] px-3 text-sm font-semibold text-[var(--app-text)] hover:border-[var(--app-accent)] hover:text-[var(--app-accent)]">
                <Upload className="size-4" />
                Select .docx
                <input
                  className="sr-only"
                  type="file"
                  accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={handleCvChange}
                />
              </label>
              {cvFile ? (
                <p
                  className="rounded-lg border border-[var(--app-info-border)] bg-[var(--app-accent-soft)] px-3 py-2 text-sm text-[var(--app-accent)]"
                  role="status"
                >
                  Selected file: {cvFile.name}
                </p>
              ) : null}
              <button
                type="button"
                className="min-h-10 w-full rounded-lg bg-[var(--app-accent)] px-4 text-sm font-semibold text-[var(--app-on-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void handleUploadCv()}
                disabled={!cvFile || uploadingCv}
              >
                {uploadingCv ? "Uploading..." : "Upload CV"}
              </button>
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)]">
            <div className="border-b border-[var(--app-border)] px-4 py-4 sm:px-5">
              <h2 className="font-semibold text-[var(--app-text)]">Session</h2>
              <p className="mt-0.5 text-sm text-[var(--app-text-muted)]">
                Sign out of the current device.
              </p>
            </div>
            <div className="p-4 sm:p-5">
              <button
                type="button"
                className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] px-4 text-sm font-semibold text-[var(--app-text)] hover:bg-[var(--app-panel-alt)] disabled:opacity-50"
                onClick={() => void handleLogout()}
                disabled={loggingOut}
              >
                <LogOut className="size-4" />
                {loggingOut ? "Logging out..." : "Log out"}
              </button>
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)]">
            <div className="flex items-start justify-between gap-3 border-b border-[var(--app-border)] px-4 py-4 sm:px-5">
              <div>
                <h2 className="font-semibold text-[var(--app-text)]">
                  Outlook calendar
                </h2>
                <p className="mt-0.5 text-sm text-[var(--app-text-muted)]">
                  Manage the calendar connection used by report workflows.
                </p>
              </div>
              <button
                type="button"
                title="Refresh Outlook status"
                aria-label="Refresh Outlook status"
                className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--app-border)] text-[var(--app-text-muted)] hover:bg-[var(--app-panel-alt)] hover:text-[var(--app-text)] disabled:opacity-40"
                onClick={() => void refreshOutlookStatus()}
                disabled={outlookLoading || outlookBusy}
              >
                <RefreshCw
                  className={`size-4 ${outlookLoading ? "animate-spin" : ""}`}
                />
              </button>
            </div>
            <div className="space-y-4 p-4 sm:p-5">
              <div className="flex items-center gap-3 rounded-lg bg-[var(--app-panel-alt)] p-3">
                <span
                  className={`grid size-10 shrink-0 place-items-center rounded-lg ${
                    outlookStatus.connected
                      ? "bg-[var(--app-success-soft)] text-[var(--app-success)]"
                      : "bg-[var(--app-accent-soft)] text-[var(--app-accent)]"
                  }`}
                >
                  <CalendarDays className="size-5" />
                </span>
                <div className="min-w-0">
                  <p className="font-semibold text-[var(--app-text)]">
                    {outlookStatus.connected
                      ? "Outlook connected"
                      : "Outlook not connected"}
                  </p>
                  <p className="mt-0.5 break-words text-sm text-[var(--app-text-muted)]">
                    {outlookStatus.email ||
                      "Connect an account to enable calendar-aware workflows."}
                  </p>
                </div>
              </div>
              {outlookError ? (
                <div
                  role="alert"
                  className="rounded-lg border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] px-3 py-2.5 text-sm text-[var(--app-danger)]"
                >
                  {outlookError}
                </div>
              ) : null}
              <button
                type="button"
                className="min-h-10 w-full rounded-lg bg-[var(--app-accent)] px-4 text-sm font-semibold text-[var(--app-on-accent)] hover:opacity-90 disabled:opacity-50"
                onClick={() => setIsOutlookDialogOpen(true)}
                disabled={outlookBusy}
              >
                Manage Outlook connection
              </button>
            </div>
          </section>
        </div>
      </div>

      <section className="rounded-xl border border-[var(--app-danger-border)] bg-[var(--app-panel)] p-4 sm:p-5">
        <h2 className="font-semibold text-[var(--app-text)]">Danger zone</h2>
        <p className="mt-1 text-sm text-[var(--app-text-muted)]">
          Deleting your account removes your account and security/device records.
          Reports, uploaded media and activity history are not automatically deleted.
          Download any work you are authorized to keep before continuing.
        </p>
        <p className="mt-2 text-sm text-[var(--app-text-muted)]">
          <Link href="/account-deletion" prefetch={false} className="underline underline-offset-4">Account and data-deletion instructions</Link>
          {" · "}<Link href="/privacy" className="underline underline-offset-4">Privacy notice</Link>
        </p>
        <button
          type="button"
          className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg bg-[var(--app-danger)] px-4 text-sm font-semibold text-white hover:opacity-90"
          onClick={() => {
            deleteOwner.current = ownerId;
            deleteSession.current = captureAuthSession();
            setIsDeleteOpen(true);
            setConfirmText("");
            setDeletePassword("");
            setError(null);
          }}
        >
          <Trash2 className="size-4" />
          Delete account
        </button>
      </section>

      <dialog
        ref={deleteDialogRef}
        aria-labelledby="delete-account-title"
        aria-describedby="delete-account-description"
        className="m-auto w-[min(92vw,520px)] rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-0 text-[var(--app-text)] shadow-[var(--app-shadow-modal)] backdrop:bg-[var(--app-overlay)]"
        onCancel={(event) => {
          if (deleting) event.preventDefault();
          else setIsDeleteOpen(false);
        }}
        onClose={() => {
          if (isDeleteOpen && !deleting) setIsDeleteOpen(false);
        }}
      >
        <div className="p-5">
          <h2 id="delete-account-title" className="text-lg font-bold">
            Delete account
          </h2>
          <div id="delete-account-description" className="mt-3 rounded-lg border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] px-3 py-2.5 text-sm text-[var(--app-danger)]">
            Type <strong>DELETE</strong> to confirm permanent account removal.
            {" "}You will lose sign-in access. Reports, media and activity history
            require a separate <Link href="/account-deletion" prefetch={false} className="underline underline-offset-4">data-removal request</Link>.
          </div>
          <label className="mt-4 block">
            <span className="mb-1.5 block text-sm font-semibold">
              Type DELETE to confirm
            </span>
            <input
              value={confirmText}
              disabled={deleting}
              onChange={(event) => setConfirmText(event.target.value)}
              autoComplete="off"
              className="min-h-10 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm outline-none focus:border-[var(--app-danger)] focus:ring-2 focus:ring-[var(--app-danger-ring)]"
            />
          </label>
          {needsPassword ? (
            <label className="mt-4 block">
              <span className="mb-1.5 block text-sm font-semibold">
                Password
              </span>
              <input
                type="password"
                value={deletePassword}
                disabled={deleting}
                onChange={(event) => setDeletePassword(event.target.value)}
                autoComplete="current-password"
                className="min-h-10 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm outline-none focus:border-[var(--app-danger)] focus:ring-2 focus:ring-[var(--app-danger-ring)]"
              />
            </label>
          ) : null}
          {error ? (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] px-3 py-2.5 text-sm text-[var(--app-danger)]"
            >
              {error}
            </div>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="min-h-10 rounded-lg border border-[var(--app-border)] px-4 text-sm font-semibold hover:bg-[var(--app-panel-alt)] disabled:opacity-50"
              onClick={() => setIsDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="min-h-10 rounded-lg bg-[var(--app-danger)] px-4 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => void confirmDelete()}
              disabled={
                deleting ||
                confirmText !== "DELETE" ||
                (needsPassword && !deletePassword)
              }
            >
              {deleting ? "Deleting..." : "Permanently delete"}
            </button>
          </div>
        </div>
      </dialog>

      {isOutlookDialogOpen ? (
        <OutlookConnectionDialog
          open
          onClose={() => setIsOutlookDialogOpen(false)}
          status={outlookStatus}
          loading={outlookLoading}
          busy={outlookBusy}
          error={outlookError}
          onRefresh={() => void refreshOutlookStatus()}
          onConnect={() => void connectOutlook()}
          onDisconnect={() => void disconnectOutlook()}
        />
      ) : null}
    </main>
  );
}
