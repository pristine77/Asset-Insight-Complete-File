"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, LoaderCircle, RefreshCw, Save, Send, X } from "lucide-react";
import { ReportsService } from "@/services/reports";
import { SalvageService, salvageHasPreview, salvageIsProcessing, salvageStatusPath, type SalvagePreviewData, type SalvageReport } from "@/services/salvage";
import { salvageSystemText } from "@/lib/salvagePresentation";
import { salvageResearchRequestId, salvageResearchRequestKey } from "@/lib/salvageResearchRequest";
import { isSalvageAssessmentV2 } from "@/lib/salvageAssessment";
import SalvageAssessmentEditor from "./SalvageAssessmentEditor";
import SalvageReportEnrichment from "./SalvageReportEnrichment";
import SalvageReportContextEditor from "./SalvageReportContextEditor";
import styles from "./SalvagePreviewWorkspace.module.css";

type Field = readonly [key: string, label: string, type?: "date" | "textarea" | "number" | "email", readOnly?: boolean];
const REPORT_FIELDS: Field[] = [
  ["file_number", "File number"], ["claim_number", "Claim number"], ["policy_number", "Policy number"],
  ["report_date", "Report date", "date"], ["date_received", "Date received", "date"], ["next_report_due", "Next report due", "date"],
  ["date_of_loss", "Date of loss", "date"], ["reported_loss_type", "Reported loss type"], ["insured_name", "Insured name"],
];
const VEHICLE_FIELDS: Field[] = [
  ["item_type", "Item type"], ["year", "Year"], ["make", "Make"], ["item_model", "Model"], ["vin", "VIN / serial number"],
  ["item_condition", "Condition"], ["is_repairable", "Repairable"], ["repair_facility", "Repair facility"],
  ["damage_description", "Damage description", "textarea"], ["inspection_comments", "Inspection comments", "textarea"],
  ["repair_facility_comments", "Repair facility comments", "textarea"],
  ["cause_of_loss_summary", "Cause of loss", "textarea"], ["appraiser_comments", "Appraiser comments", "textarea"],
];
const CONTACT_FIELDS: Field[] = [
  ["appraiser_name", "Appraiser name"], ["appraiser_phone", "Appraiser phone"], ["appraiser_email", "Appraiser email", "email"],
  ["adjuster_name", "Adjuster name"], ["company_name", "Company name"], ["company_address", "Company address"],
];
const NOTES_FIELDS: Field[] = [["procurement_notes", "Procurement notes", "textarea"], ["assumptions", "Assumptions", "textarea"], ["safety_concerns", "Safety concerns", "textarea"]];
const PART_FIELDS: Field[] = [["name", "Part"], ["quantity", "Quantity", "number"], ["unit_price", "Unit price", "number"], ["line_total", "Line total", "number", true], ["sku", "SKU"], ["vendor", "Vendor"], ["lead_time_days", "Lead time (days)", "number"], ["notes", "Notes"]];
const LABOUR_FIELDS: Field[] = [["task", "Task"], ["hours", "Hours", "number"], ["rate_per_hour", "Hourly rate", "number"], ["line_total", "Line total", "number", true], ["notes", "Notes"]];
const STAGES: Record<string, string> = { preparing_preview: "Preparing preview", preview_ready: "Ready for review", generating_files: "Generating files", awaiting_approval: "Awaiting approval", awaiting_release: "Awaiting release", ready: "Ready to download", error: "Processing failed", stopped: "Processing stopped" };
const FILES = [["pdf", "PDF"], ["docx", "DOCX"], ["xlsx", "XLSX"], ["images", "Photo ZIP"]] as const;
const scalar = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
const amount = (value: unknown): number | undefined => {
  if (value === "" || value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const lineTotal = (item: Record<string, unknown>, labour: boolean, defaultRate: unknown) => {
  const quantity = amount(item[labour ? "hours" : "quantity"]);
  const rate = amount(item[labour ? "rate_per_hour" : "unit_price"]) ?? (labour ? amount(defaultRate) ?? 0 : undefined);
  return quantity !== undefined && rate !== undefined ? round(quantity * rate) : amount(item.line_total) ?? 0;
};
const errorMessage = (error: unknown, fallback: string) => {
  const value = error as { response?: { data?: { message?: string } }; message?: string };
  return salvageSystemText(value?.response?.data?.message || value?.message, fallback);
};

export default function SalvagePreviewWorkspace({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [report, setReport] = useState<SalvageReport | null>(null);
  const [draft, setDraft] = useState<SalvagePreviewData>({});
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [photo, setPhoto] = useState<number | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const version = useRef(0);
  const dirtyRef = useRef(false);
  const mutation = useRef(false);
  const fetching = useRef(false);
  const downloadLock = useRef(false);

  const load = useCallback(async (replace = false) => {
    if (fetching.current || mutation.current) return;
    fetching.current = true;
    const epoch = version.current;
    setRefreshing(true);
    try {
      const response = await SalvageService.getPreview(reportId);
      if (epoch !== version.current) return;
      if (replace || !dirtyRef.current) {
        setReport(response.data);
        setDraft(response.data.preview_data || {});
        dirtyRef.current = false;
        setDirty(false);
        setConflict(false);
      } else {
        // Poll lifecycle only while editing; keep the base revision so a stale
        // save is rejected instead of silently overwriting another appraiser.
        setReport((old) => old ? { ...response.data, revision: old.revision } : response.data);
      }
      if (!dirtyRef.current || replace) setError(null);
    } catch (cause) {
      if (epoch === version.current) setError(errorMessage(cause, "Could not load the salvage report. Try again."));
    } finally {
      if (epoch === version.current) { fetching.current = false; setLoading(false); setRefreshing(false); }
    }
  }, [reportId]);

  useEffect(() => {
    version.current += 1;
    fetching.current = false;
    mutation.current = false;
    dirtyRef.current = false;
    setReport(null); setDraft({}); setDirty(false); setLoading(true); setBusy(null); setError(null); setNotice(null); setConflict(false);
    void load(true);
    return () => { version.current += 1; };
  }, [load]);

  const processing = report ? salvageIsProcessing(report) : false;
  useEffect(() => {
    if ((processing || report?.preview_available === false) && !dirtyRef.current && !mutation.current) router.replace(salvageStatusPath(reportId));
  }, [processing, report?.preview_available, reportId, router]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden && navigator.onLine !== false) void load(); };
    const timer = window.setInterval(refresh, processing ? 5000 : 30000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); };
  }, [processing, load]);

  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);

  useEffect(() => {
    if (photo !== null) dialog.current?.showModal();
    else dialog.current?.close();
  }, [photo]);

  const canEdit = Boolean(report && Number.isInteger(report.revision) && report.preview_available !== false && !processing && !busy && !loading);
  const update = (key: string, value: unknown) => {
    if (!canEdit || mutation.current) return;
    dirtyRef.current = true; setDirty(true); setNotice(null);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const run = async (action: "save" | "submit" | "retry" | "research") => {
    if (!report || loading || processing || mutation.current || fetching.current) return;
    if (action !== "retry" && (!Number.isInteger(report.revision) || conflict)) return;
    if (action === "submit" && dirtyRef.current) { setError("Save your changes before submitting."); return; }
    if (action === "retry" && dirtyRef.current) { setError("Save or reload your changes before retrying."); return; }
    if (action === "research") {
      if (dirtyRef.current) { setError("Save your changes before researching again."); return; }
      if (!window.confirm("Start a new Canadian salvage research run from this saved revision? It can take up to 15 minutes. Existing files will need regeneration and approval. Ordinary saves do not run research.")) return;
    }
    mutation.current = true;
    // Fence any older pending response; only this mutation may adopt its result.
    const epoch = ++version.current;
    setBusy(action); setError(null); setNotice(null);
    try {
      const response = action === "save"
        ? await SalvageService.savePreview(reportId, draft, report.revision)
        : action === "retry" ? await (report.status === "cancelled" ? SalvageService.retry(reportId, report.revision) : SalvageService.retry(reportId))
          : action === "research" ? await SalvageService.research(reportId, report.revision, salvageResearchRequestId(reportId, report.revision))
          : await SalvageService.submit(reportId, report.revision, ["pending_approval", "approved"].includes(report.status));
      if (epoch !== version.current) return;
      if (action === "research") {
        // Cleanup is best-effort after confirmed acceptance, never a reason to
        // present a successful paid action as failed.
        try { sessionStorage.removeItem(salvageResearchRequestKey(reportId, report.revision)); } catch { /* harmless stale identity */ }
      }
      setReport(response.data); setDraft(response.data.preview_data || {});
      dirtyRef.current = false; setDirty(false); setConflict(false);
      setNotice(action === "save" ? "Changes saved. Submit when ready to create updated files." : "Processing accepted. Follow the progress here; do not create another report.");
      window.dispatchEvent(new Event("cv:report-created"));
      if (action !== "save") router.push(salvageStatusPath(reportId));
    } catch (cause) {
      if (epoch !== version.current) return;
      const isConflict = (cause as { response?: { data?: { code?: string } } })?.response?.data?.code === "SALVAGE_REVISION_CONFLICT";
      setConflict(isConflict);
      setError(isConflict ? "This report changed on another device. Your edits are still here. Copy any changes you need, then reload the latest version before saving." : errorMessage(cause, "The request failed. Your changes have been kept. Please try again."));
    } finally {
      if (epoch === version.current) { mutation.current = false; setBusy(null); }
    }
  };

  const reload = () => {
    if (mutation.current) return;
    if (dirtyRef.current && !window.confirm("Reload the latest saved report? Unsaved changes on this page will be discarded.")) return;
    void load(true);
  };
  const back = () => {
    if (mutation.current) return;
    if (dirtyRef.current && !window.confirm("Leave this report? Unsaved changes will be lost.")) return;
    router.push("/reports");
  };
  const showProgress = () => {
    if (mutation.current) return;
    if (dirtyRef.current && !window.confirm("Close preview and view progress? Unsaved changes will be lost.")) return;
    router.push(salvageStatusPath(reportId));
  };
  const download = async (fileId: string, kind: string) => {
    if (!report?.downloadable || processing || dirtyRef.current || mutation.current || downloadLock.current) return;
    downloadLock.current = true; setDownloading(kind); setError(null);
    try {
      const result = await ReportsService.downloadReport(fileId);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url; link.download = result.filename || `salvage-${report.file_number}.${kind === "images" ? "zip" : kind}`;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(errorMessage(cause, "Download failed. Refresh the report status and try again.")); }
    finally { downloadLock.current = false; setDownloading(null); }
  };

  const field = ([key, label, type, readOnly]: Field, source: SalvagePreviewData = draft, change = update, prefix = "") => {
    const value = scalar(source[key]);
    const id = `salvage-${prefix}${key}`;
    return <label key={key} htmlFor={id} className={`${styles.field} ${type === "textarea" ? styles.wide : ""}`}>
      {label}
      {type === "textarea" ? <textarea id={id} value={value} readOnly={readOnly} disabled={!canEdit} onChange={(event) => change(key, event.target.value)} />
        : <input id={id} type={type || "text"} step={type === "number" ? "any" : undefined} min={type === "number" ? 0 : undefined}
          value={type === "date" ? value.slice(0, 10) : value} disabled={!canEdit} readOnly={readOnly}
          onChange={(event) => change(key, type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)} />}
    </label>;
  };
  const section = (title: string, fields: Field[]) => <section className={styles.section}><h2>{title}</h2><div className={styles.fields}>{fields.map((entry) => field(entry))}</div></section>;
  const selection = (key: string, label: string, options: readonly (readonly [string, string])[]) => <label className={styles.field}>
    {label}<select value={scalar(draft[key])} disabled={!canEdit} onChange={(event) => update(key, event.target.value)}><option value="">Not specified</option>{options.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select>
  </label>;
  const estimates = (key: "repair_items" | "labour_breakdown", title: string, columns: Field[]) => {
    const items = rows(draft[key]);
    return <section className={styles.section}>
      <div className={styles.sectionHeading}><h2>{title}</h2><button className="app-button" type="button" disabled={!canEdit} onClick={() => update(key, [...items, key === "repair_items" ? { name: "", quantity: 1, unit_price: 0, line_total: 0 } : { task: "", hours: 0, rate_per_hour: 0, line_total: 0 }])}>Add {key === "repair_items" ? "part" : "labour"}</button></div>
      {!items.length ? <p className={styles.muted}>No {title.toLowerCase()} recorded.</p> : <div className={styles.rows}>{items.map((item, index) => <div key={index} className={styles.row}>
        <div className={styles.fields}>{columns.map((entry) => field(entry, { ...item, line_total: lineTotal(item, key === "labour_breakdown", draft.labour_rate_default) }, (name, value) => update(key, items.map((row, rowIndex) => rowIndex === index ? { ...row, [name]: value } : row)), `${key}-${index}-`))}</div>
        <button type="button" className="app-button mt-2" disabled={!canEdit} aria-label={`Remove ${key === "repair_items" ? "part" : "labour"} ${index + 1}`} onClick={() => update(key, items.filter((_, rowIndex) => rowIndex !== index))}>Remove</button>
      </div>)}</div>}
    </section>;
  };
  const failed = report?.status === "error" || report?.generation_state === "error" || report?.workflow_stage === "error";
  const stage = report ? STAGES[report.workflow_stage || ""] || report.status.replaceAll("_", " ") : "Loading report";
  const valuation = object(draft.valuation);
  const assessment = isSalvageAssessmentV2(draft.assessment) ? draft.assessment : null;
  const photos = report?.imageUrls || [];
  const analysis = object(draft.aiExtractedDetails);
  const estimate = object(draft.repair_estimate);
  const parts = rows(draft.repair_items);
  const labour = rows(draft.labour_breakdown);
  const partsTotal = !parts.length && estimate.parts_itemized === false ? amount(estimate.parts) ?? 0 : round(parts.reduce((sum, item) => sum + lineTotal(item, false, 0), 0));
  const labourTotal = !labour.length && estimate.labour_itemized === false ? amount(estimate.labour) ?? 0 : round(labour.reduce((sum, item) => sum + lineTotal(item, true, draft.labour_rate_default), 0));
  const total = round(partsTotal + labourTotal + (amount(estimate.shop_supplies) ?? 0) + (amount(estimate.miscellaneous) ?? 0) + (amount(estimate.taxes) ?? 0) - (amount(estimate.less_betterment) ?? 0));

  if (report && !dirty && (processing || report.preview_available === false)) {
    return <main className={styles.page} aria-label="Salvage report workspace"><h1>Opening report progress</h1>
      <p role="status" className={styles.notice}>Your saved report continues in the progress workspace. The preview stays closed until you choose to open it.</p>
      <button type="button" className="app-button" onClick={showProgress}>View progress</button>
    </main>;
  }

  return <main className={styles.page} aria-label="Salvage report workspace">
    <header className={styles.header}><div><h1>Salvage report preview</h1><p className={styles.muted}>{report?.file_number || "Report review"} · {stage}</p></div>
      <div className={styles.actions}><button className="app-button" type="button" disabled={Boolean(busy)} onClick={back}><ArrowLeft className="size-4" /> Reports</button><button className="app-button" type="button" disabled={Boolean(busy)} onClick={showProgress}>Close preview / View progress</button><button className="app-button" type="button" disabled={Boolean(busy) || refreshing} onClick={reload}><RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} /> {conflict ? "Reload latest" : "Refresh"}</button></div>
    </header>
    {error ? <div role="alert" className={`${styles.notice} ${styles.error}`}>{error}{!report ? <button className="app-button mt-2" type="button" disabled={refreshing} onClick={reload}>Try again</button> : null}</div> : null}
    {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
    {loading ? <p role="status" className={styles.notice}>Loading salvage report…</p> : report ? <>
      <section className={styles.notice} aria-label="Report status" aria-live="polite"><strong>{stage}</strong><p>{salvageSystemText(report.workflow_message) || (processing ? "Your report is being processed. You can return here from Reports or Previews." : "Review the details below. Save edits, then submit to generate the report files.")}</p>
        {processing ? <progress className={styles.progress} aria-label="Salvage processing progress" max={100} value={Math.max(0, Math.min(100, report.workflow_progress_percent || 0))} /> : null}
        {failed ? <><p className="mt-2">{salvageSystemText(report.job_error) || "Processing did not finish. Retry this report to keep its saved details and photos."}</p><button className="app-button mt-2" type="button" disabled={Boolean(busy) || dirty} onClick={() => void run("retry")}>Retry processing</button></> : null}
        {report.decline_reason ? <p className="mt-2">Review note: {report.decline_reason}</p> : null}
      </section>
      {Object.keys(draft).length > 0 && (report.preview_available !== false || dirty) && (!processing || dirty) ? <>
        <SalvageReportEnrichment value={draft.report_enrichment} language={scalar(draft.language)} dirty={dirty} />
        {section("Report & claim", REPORT_FIELDS)}
        <section className={styles.section}><h2>Report preferences</h2><div className={styles.fields}>
          {selection("language", "Report language", [["en", "English"], ["fr", "French"], ["es", "Spanish"]])}
          {selection("priority_level", "Priority", [["High", "High"], ["Medium", "Medium"], ["Low", "Low"]])}
        </div></section>
        <SalvageReportContextEditor value={draft.report_context} language={scalar(draft.language)} disabled={!canEdit || conflict} onChange={value => update("report_context", value)} />
        {assessment ? <SalvageAssessmentEditor assessment={assessment} inputs={draft.assessment_inputs || assessment.inputs}
          disabled={!canEdit || conflict} onChange={(inputs) => update("assessment_inputs", inputs)} photos={photos} onViewPhoto={setPhoto} /> : <>
        {section("Vehicle & condition", VEHICLE_FIELDS)}
        <section className={styles.section}><h2>Valuation</h2><div className={styles.fields}>
          {field(["currency", "Currency"])}
          {([ ["fairMarketValue", "Fair market value"], ["confidence_level", "Confidence"], ["summary", "Valuation summary", "textarea"] ] as Field[]).map((entry) => field(entry, valuation, (key, value) => update("valuation", { ...valuation, [key]: value }), "valuation-"))}
          {field(["actual_cash_value", "Actual cash value", "number"])}{field(["replacement_cost", "Replacement cost", "number"])}{field(["recommended_reserve", "Recommended reserve", "number"])}
        </div><p className={`${styles.muted} mt-2`}>Amounts are in the selected currency. Repair estimates do not automatically change the fair market value.</p></section>
        <section className={styles.section}><h2>Repair cost summary</h2><div className={styles.fields}>
          {field(["labour_rate_default", "Default hourly rate", "number"])}
          {([ ["parts", "Parts subtotal", "number", !(estimate.parts_itemized === false && !parts.length)], ["labour", "Labour total", "number", !(estimate.labour_itemized === false && !labour.length)], ["shop_supplies", "Shop supplies", "number"], ["miscellaneous", "Miscellaneous", "number"], ["taxes", "Taxes", "number"], ["less_betterment", "Less betterment", "number"], ["total", "Total repair estimate", "number", true] ] as Field[]).map((entry) => field(entry, { ...estimate, parts: partsTotal, labour: labourTotal, total }, (key, value) => update("repair_estimate", { ...estimate, [key]: value }), "estimate-"))}
        </div><p className={`${styles.muted} mt-2`}>Itemized totals are calculated from quantity × unit price and hours × hourly rate. The server confirms all totals on save. {scalar(draft.estimate_warning)}</p></section>
        {estimates("repair_items", "Repair parts", PART_FIELDS)}
        {estimates("labour_breakdown", "Labour estimate", LABOUR_FIELDS)}
        </>}
        {section("Procurement & safety", NOTES_FIELDS)}
        {section("Appraiser & company", CONTACT_FIELDS)}
        {!assessment && Object.keys(analysis).length ? <section className={styles.section}><details><summary className="cursor-pointer text-sm font-semibold">Original analysis (read-only)</summary><dl className={`${styles.analysis} mt-3`}>{Object.entries(analysis).filter(([, value]) => typeof value === "string" || typeof value === "number").map(([key, value]) => <div key={key} className="contents"><dt>{key.replaceAll("_", " ")}</dt><dd>{scalar(value)}</dd></div>)}</dl></details></section> : null}
      </> : null}
      <section className={styles.section}><h2>Photos ({photos.length})</h2><p className={`${styles.muted} mb-3`}>Original report photos are preserved. Open a photo to inspect its details.</p><div className={styles.photos}>{photos.map((url, index) => <button key={`${url}-${index}`} type="button" className={styles.photo} onClick={() => setPhoto(index)} aria-label={`View photo ${index + 1}`}><img src={url} alt={`Report photo ${index + 1}`} loading="lazy" /><span>Photo {index + 1}</span></button>)}</div></section>
      <section className={styles.section}><h2>Report files</h2><p className={`${styles.muted} mb-3`}>{dirty ? "Save and submit your changes to generate updated files." : report.downloadable ? "Available files for this saved report." : processing ? "Files will appear after generation, approval and release are complete." : "Downloads become available after the required approval and release. Use Submit to generate a preview's report files."}</p><div className={styles.actions}>{FILES.map(([kind, label]) => <button key={kind} type="button" className="app-button" disabled={!report.downloadable || !report.files?.[kind] || processing || dirty || Boolean(busy) || Boolean(downloading)} onClick={() => void download(report.files![kind]!, kind)}>{downloading === kind ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />} {label}</button>)}</div></section>
      <footer className={styles.footer}><span role="status" className={styles.muted}>{busy ? "Please wait until this request finishes. Do not close the page." : dirty ? "Unsaved changes" : `Saved revision ${report.revision ?? "—"}`}</span><div className={styles.actions}>
        <button type="button" className="app-button" disabled={!canEdit || dirty || conflict || refreshing || failed} onClick={() => void run("research")}><RefreshCw className="size-4" /> Research again</button>
        <button type="button" className="app-button" disabled={!canEdit || !dirty || conflict || refreshing} onClick={() => void run("save")}><Save className="size-4" /> {busy === "save" ? "Saving…" : "Save changes"}</button>
        <button type="button" className="app-button app-button--primary" disabled={!canEdit || !salvageHasPreview(report) || dirty || conflict || refreshing || failed || !["preview", "declined", "pending_approval", "approved", "cancelled"].includes(report.status)} onClick={() => void run("submit")}><Send className="size-4" /> {busy === "submit" ? "Submitting…" : ["pending_approval", "approved", "cancelled"].includes(report.status) ? "Resubmit report" : "Submit report"}</button>
      </div></footer>
    </> : null}
    <dialog ref={dialog} className={styles.viewer} aria-label="Report photo viewer" onCancel={() => setPhoto(null)} onClose={() => setPhoto(null)}><div className={styles.actions}><p>Photo {photo === null ? "" : photo + 1} of {photos.length}</p><button type="button" className="app-button" onClick={() => setPhoto(null)} aria-label="Close photo"><X className="size-4" /></button></div>{photo !== null && photos[photo] ? <img src={photos[photo]} alt={`Report photo ${photo + 1}`} /> : null}</dialog>
  </main>;
}
