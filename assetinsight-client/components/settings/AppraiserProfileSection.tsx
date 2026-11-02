"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, PenLine, Trash2, Upload } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { UserService } from "@/services/user";
import { captureAuthSession, isAuthSessionCurrent } from "@/lib/auth-storage";

/*
  Appraiser profile (owner, 2026-11-01: the signature block and CV on Salvage
  appraisal reports come from "a profile, set once"). Designation and title
  print beside the appraiser's name; the signature signs the report summary
  and the certification; the CV PDF is added after the certification. A report
  uses them only when it names this user as its appraiser. Name, phone and
  email are taken from each report.
*/

type Profile = {
  designation?: string; title?: string; signatureUrl?: string;
  cvPdfUrl?: string; cvPdfFilename?: string; cvPdfPages?: number;
};

const errorText = (error: unknown, fallback: string) =>
  (error as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;

const LINK = "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--app-border)] px-3 text-xs font-semibold text-[var(--app-text)] hover:border-[var(--app-accent)] hover:text-[var(--app-accent)] disabled:opacity-50";
const DANGER = "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--app-danger-border)] px-3 text-xs font-semibold text-[var(--app-danger)] hover:bg-[var(--app-danger-soft)] disabled:opacity-50";
const FIELD = "min-h-10 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none";

export default function AppraiserProfileSection({ profile, onSaved }: { profile: Profile | undefined; onSaved: () => Promise<unknown> | void }) {
  const [designation, setDesignation] = useState(profile?.designation || "");
  const [title, setTitle] = useState(profile?.title || "");
  const [busy, setBusy] = useState<null | "text" | "signature" | "cv">(null);
  const signatureInput = useRef<HTMLInputElement>(null);
  const cvInput = useRef<HTMLInputElement>(null);
  const request = useRef<symbol | null>(null);

  useEffect(() => () => { request.current = null; }, []);

  useEffect(() => { setDesignation(profile?.designation || ""); setTitle(profile?.title || ""); }, [profile?.designation, profile?.title]);
  const changed = designation.trim() !== (profile?.designation || "") || title.trim() !== (profile?.title || "");

  async function run(kind: "text" | "signature" | "cv", work: () => Promise<unknown>, done: string, failed: string) {
    if (request.current) return;
    const operation = Symbol();
    const session = captureAuthSession();
    request.current = operation;
    const current = () => request.current === operation && isAuthSessionCurrent(session);
    setBusy(kind);
    try {
      await work();
      if (!current()) return;
      await onSaved();
      if (current()) toast.success(done);
    }
    catch (error) { if (current()) toast.error(errorText(error, failed)); }
    finally {
      if (request.current === operation) { request.current = null; setBusy(null); }
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)]" aria-labelledby="appraiser-profile-heading">
      <div className="border-b border-[var(--app-border)] px-4 py-4 sm:px-5">
        <h2 id="appraiser-profile-heading" className="font-semibold text-[var(--app-text)]">Appraiser profile</h2>
        <p className="mt-0.5 text-sm text-[var(--app-text-muted)]">
          Printed on the Salvage appraisal reports you sign: your designation and title, your signature, and your CV after the certification.
        </p>
      </div>
      <div className="space-y-4 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <label className="grid gap-1.5 text-[13px] font-semibold text-[var(--app-text)]" htmlFor="appraiser-designation">
            Designation
            <input id="appraiser-designation" className={FIELD} value={designation} disabled={busy === "text"} maxLength={40} placeholder="CPPA" onChange={(e) => setDesignation(e.target.value)} />
          </label>
          <label className="grid gap-1.5 text-[13px] font-semibold text-[var(--app-text)]" htmlFor="appraiser-title">
            Title
            <input id="appraiser-title" className={FIELD} value={title} disabled={busy === "text"} maxLength={120} placeholder="Appraiser, RSE – Journeyman Mechanic" onChange={(e) => setTitle(e.target.value)} />
          </label>
        </div>
        <button type="button" className="app-button app-button--primary" disabled={!changed || Boolean(busy)}
          onClick={() => void run("text", () => UserService.updateAppraiserProfile({ designation: designation.trim(), title: title.trim() }), "Appraiser profile saved", "Failed to save the appraiser profile")}>
          {busy === "text" ? "Saving..." : "Save designation and title"}
        </button>

        <div className="rounded-lg bg-[var(--app-panel-alt)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--app-text-muted)]">Signature</p>
          {profile?.signatureUrl ? (
            <img src={profile.signatureUrl} alt="Your signature" className="mt-2 max-h-16 max-w-full rounded border border-[var(--app-border)] bg-white object-contain p-1" />
          ) : (
            <p className="mt-2 text-sm text-[var(--app-text-muted)]">No signature yet. Sign on white paper, take a clear photo or scan, and upload it.</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={LINK} disabled={Boolean(busy)} onClick={() => signatureInput.current?.click()}>
              <PenLine className="size-3.5" /> {busy === "signature" ? "Uploading..." : profile?.signatureUrl ? "Replace signature" : "Upload signature"}
            </button>
            {profile?.signatureUrl ? (
              <button type="button" className={DANGER} disabled={Boolean(busy)}
                onClick={() => void run("signature", () => UserService.deleteAppraiserSignature(), "Signature removed", "Failed to remove the signature")}>
                <Trash2 className="size-3.5" /> Remove
              </button>
            ) : null}
          </div>
          <input ref={signatureInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Signature image"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) void run("signature", () => UserService.uploadAppraiserSignature(file), "Signature saved", "Failed to upload the signature");
            }} />
        </div>

        <div className="rounded-lg bg-[var(--app-panel-alt)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--app-text-muted)]">CV for appraisal reports (PDF)</p>
          {profile?.cvPdfUrl ? (
            <p className="mt-2 break-words text-sm text-[var(--app-text)]">{profile.cvPdfFilename || "CV.pdf"} · {profile.cvPdfPages || 1} page{profile.cvPdfPages === 1 ? "" : "s"}</p>
          ) : (
            <p className="mt-2 text-sm text-[var(--app-text-muted)]">No CV PDF yet. Up to 10 pages; it prints after the certification on every report you sign.</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {profile?.cvPdfUrl ? (
              <a href={profile.cvPdfUrl} target="_blank" rel="noreferrer" className={LINK}><ExternalLink className="size-3.5" /> View CV</a>
            ) : null}
            <button type="button" className={LINK} disabled={Boolean(busy)} onClick={() => cvInput.current?.click()}>
              <Upload className="size-3.5" /> {busy === "cv" ? "Uploading..." : profile?.cvPdfUrl ? "Replace CV" : "Upload CV PDF"}
            </button>
            {profile?.cvPdfUrl ? (
              <button type="button" className={DANGER} disabled={Boolean(busy)}
                onClick={() => void run("cv", () => UserService.deleteAppraiserCvPdf(), "CV removed", "Failed to remove the CV")}>
                <Trash2 className="size-3.5" /> Remove
              </button>
            ) : null}
          </div>
          <input ref={cvInput} type="file" accept="application/pdf,.pdf" className="sr-only" aria-label="CV PDF"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) void run("cv", () => UserService.uploadAppraiserCvPdf(file), "CV saved", "Failed to upload the CV");
            }} />
        </div>
      </div>
    </section>
  );
}
