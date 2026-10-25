"use client";

import dynamic from "next/dynamic";
import { Pencil, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthUser } from "@/services/auth";
import { CRM_READ_TIMEOUT_MS, CRM_SPECIALIZATION_OPTIONS, crmErrorMessage } from "@/services/crm";
import { UserService } from "@/services/user";
import { CRM_QUADRANT_OPTIONS, parseCrmQuadrants } from "./crmAuxiliaryHelpers";
import { useCrmOnline } from "./useCrmRead";
import styles from "./CrmCoverageScreen.module.css";

const CrmCoverageForm = dynamic(() => import("./CrmCoverageForm"));

function CoverageSession({ ownerId }: { ownerId: string }) {
  const [profile, setProfile] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const online = useCrmOnline();
  const load = useCallback(async (openAfter = false) => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setLoading(true); setError("");
    try {
      const saved = await UserService.getMe({ signal: request.signal, timeout: CRM_READ_TIMEOUT_MS });
      if (request.signal.aborted) return;
      if (saved._id !== ownerId || saved.isCrmAgent !== true) {
        setProfile(null);
        throw new Error("CRM access is no longer available for this account.");
      }
      setProfile(saved);
      if (openAfter) setEditing(true);
    } catch (failure) {
      if (!request.signal.aborted) {
        const status = (failure as { response?: { status?: number } })?.response?.status;
        if (status === 401 || status === 403 || status === 404) setProfile(null);
        setError(crmErrorMessage(failure, "Saved coverage could not be loaded."));
      }
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [ownerId]);
  useEffect(() => { void load(); return () => controller.current?.abort(); }, [load]);
  const quadrants = parseCrmQuadrants(profile?.crmQuadrant).map((value) => CRM_QUADRANT_OPTIONS.find((option) => option.value === value)?.label || value);
  const specializations = (profile?.crmSpecializations || []).map((value) => CRM_SPECIALIZATION_OPTIONS.find((option) => option.value === value)?.label || value);
  return <section className={`app-surface ${styles.panel}`} aria-label="CRM coverage">
    <header className={styles.toolbar}><p>Coverage used for CRM lead assignments.</p><div><button className="app-button app-button--secondary app-button--icon" aria-label="Refresh coverage" disabled={loading || editing || !online} onClick={() => void load()}><RefreshCw size={17} aria-hidden /></button><button className="app-button app-button--primary" disabled={loading || editing || !online} onClick={() => { setNotice(""); void load(true); }}><Pencil size={16} aria-hidden />Edit coverage</button></div></header>
    {loading && <p className={styles.state} role="status">Loading saved coverage…</p>}
    {error && <div className="app-alert app-alert--error" role="alert">{error}{profile ? " Showing the last verified values; refresh to check current coverage." : " Refresh to try again."}</div>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {profile && <dl className={styles.values}><div><dt>Service address</dt><dd>{profile.crmAddress?.trim() || "Not set"}</dd></div><div><dt>Coverage areas</dt><dd>{quadrants.join(", ") || "Not set"}</dd></div><div><dt>Specializations</dt><dd>{specializations.join(", ") || "Not set"}</dd></div></dl>}
    {editing && profile && <CrmCoverageForm ownerId={ownerId} user={profile} onClose={() => { setEditing(false); void load(); }} onSaved={(saved) => {
      setEditing(false);
      if (saved._id === ownerId && saved.isCrmAgent === true) { setProfile(saved); setNotice("Coverage saved."); }
      else void load();
    }} />}
  </section>;
}

export default function CrmCoverageScreen({ ownerId }: { ownerId: string }) {
  return <CoverageSession key={ownerId} ownerId={ownerId} />;
}
