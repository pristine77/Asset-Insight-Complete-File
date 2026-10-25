import type { ReactNode } from "react";
import { CRM_LOST_REASON_LABELS, CRM_SPECIALIZATION_OPTIONS, safeCrmUrl, type CrmTaskItem } from "@/services/crm";
import { crmDate, crmPersonLabel, crmPhoneOptions, crmSocialLinks, crmWebsite } from "./crmDetailHelpers";
import { crmSource } from "./crmListPolicy";
import styles from "./CrmTaskDetail.module.css";

type Row = { label: string; value: ReactNode; wide?: boolean };
function InfoGroup({ title, rows }: { title: string; rows: Row[] }) {
  const present = rows.filter((row) => row.value !== undefined && row.value !== null && row.value !== "");
  if (!present.length) return null;
  return <section className={styles.detailsSection}><h3>{title}</h3><dl className={styles.detailsGrid}>{present.map((row) => <div className={`${styles.detailPair} ${row.wide ? styles.wide : ""}`} key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl></section>;
}
function LinkValue({ value }: { value?: string }) {
  const href = crmWebsite(value);
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{value}</a> : <>{value}</>;
}
function LocationValue({ value }: { value: string }) {
  return <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`} target="_blank" rel="noopener noreferrer">{value}</a>;
}
function importValue(value: unknown): string {
  if (value === null || value === undefined) return "Not provided";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function CrmContactDetails({ task }: { task: CrmTaskItem }) {
  const phones = crmPhoneOptions(task);
  const socials = crmSocialLinks(task.contactSocials);
  const latestRecording = safeCrmUrl(task.latestRecordingUrl);
  const latestAttachments = (task.latestAttachmentUrls || []).flatMap((url, index) => {
    const href = safeCrmUrl(url);
    return href ? [{ href, index }] : [];
  });
  return <div className={styles.section}>
    <InfoGroup title="Contact & phones" rows={[
      { label: "Contact", value: task.clientName }, { label: "Title", value: task.title },
      { label: "Email", value: task.email || "Not provided" },
      { label: "Saved primary phone", value: task.phoneRaw && !phones.some((phone) => phone.value === task.phoneRaw) ? task.phoneRaw : undefined },
      { label: "Phone numbers", value: phones.length ? <div>{phones.map((phone) => <div key={phone.href}><a href={phone.href}>{phone.value}</a> <span className={styles.muted}>({phone.label})</span></div>)}</div> : "Not provided" },
      { label: "Contact phones", value: task.contactPhones?.join(", ") },
      { label: "Mobile phones", value: task.contactMobilePhones?.join(", ") },
      { label: "Company phones", value: task.companyPhones?.join(", ") },
      { label: "Department", value: task.department }, { label: "Seniority", value: task.seniority },
      { label: "Contact LinkedIn", value: task.contactLinkedinUrl ? <LinkValue value={task.contactLinkedinUrl} /> : undefined },
      { label: "Socials", value: task.contactSocials ? <>{task.contactSocials}{socials.length ? <div>{socials.map((url) => <div key={url}><a href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname}</a></div>)}</div> : null}</> : undefined, wide: true },
      { label: "Notes", value: task.notes, wide: true },
    ]} />
    <InfoGroup title="Location & links" rows={[
      { label: "Contact location", value: task.contactLocation ? <LocationValue value={task.contactLocation} /> : undefined },
      { label: "Company location", value: task.companyLocation ? <LocationValue value={task.companyLocation} /> : undefined },
      { label: "Quadrant", value: task.quadrant }, { label: "Specialization", value: CRM_SPECIALIZATION_OPTIONS.find((option) => option.value === task.specialization)?.label || task.specialization },
      { label: "Category", value: task.category }, { label: "Industry", value: task.industry },
      { label: "Website", value: task.website ? <LinkValue value={task.website} /> : undefined },
      { label: "Company website domain", value: task.companyWebsiteDomain ? <LinkValue value={task.companyWebsiteDomain} /> : undefined },
      { label: "Company LinkedIn", value: task.companyLinkedinUrl ? <LinkValue value={task.companyLinkedinUrl} /> : undefined },
    ]} />
    <InfoGroup title="Company details" rows={[
      { label: "Company", value: task.companyName }, { label: "Description", value: task.companyDescription, wide: true },
      { label: "Annual revenue", value: task.companyAnnualRevenue?.toLocaleString() }, { label: "Revenue range", value: task.companyRevenueRange },
      { label: "Staff count", value: task.companyStaffCount?.toLocaleString() }, { label: "Staff count range", value: task.companyStaffCountRange },
      { label: "Founded", value: task.companyFoundedDate }, { label: "Postcode", value: task.companyPostCode },
      { label: "SIC", value: task.sicCode }, { label: "NAICS", value: task.naicsCode },
      { label: "Research date", value: task.researchDate ? crmDate(task.researchDate) : undefined },
    ]} />
    <InfoGroup title="Task information" rows={[
      { label: "Source", value: crmSource(task) }, { label: "Priority", value: task.priority },
      { label: "Lost reason", value: task.lostReason ? CRM_LOST_REASON_LABELS[task.lostReason] : undefined },
      { label: "List items", value: task.listItems?.join(", "), wide: true },
      { label: "Assigned by", value: task.assignedBy ? crmPersonLabel(task.assignedBy) : undefined },
      { label: "Assigned to", value: task.assignedTo ? crmPersonLabel(task.assignedTo) : undefined },
      { label: "Contact attempts", value: task.callAttempts },
      { label: "Last contact", value: task.lastCalledAt ? crmDate(task.lastCalledAt, true) : undefined },
      { label: "Task started", value: task.taskStartDate ? crmDate(task.taskStartDate, true) : undefined },
      { label: "Due", value: task.dueDate ? crmDate(task.dueDate, true) : undefined },
      { label: "Stage changed", value: task.statusChangedAt ? crmDate(task.statusChangedAt, true) : undefined },
      { label: "Created", value: task.createdAt ? crmDate(task.createdAt, true) : undefined },
      { label: "Updated", value: task.updatedAt ? crmDate(task.updatedAt, true) : undefined },
    ]} />
    <InfoGroup title="Latest saved activity" rows={[
      { label: "Latest comment", value: task.latestComment, wide: true },
      { label: "Latest attachments", value: latestAttachments.length ? <div>{latestAttachments.map(({ href, index }) => <div key={`${href}-${index}`}><a href={href} target="_blank" rel="noopener noreferrer">Attachment {index + 1}</a></div>)}</div> : undefined },
      { label: "Latest recording", value: latestRecording ? <audio className={styles.audio} controls preload="none" src={latestRecording} aria-label="Latest saved recording" /> : undefined, wide: true },
    ]} />
    {task.importData && Object.keys(task.importData).length ? <details className={styles.detailsSection}><summary className={styles.importSummary}>Imported details ({Object.keys(task.importData).length})</summary><dl className={styles.detailsGrid}>{Object.entries(task.importData).map(([key, value]) => <div className={styles.detailPair} key={key}><dt>{key.replace(/[_-]+/g, " ")}</dt><dd>{importValue(value)}</dd></div>)}</dl></details> : null}
  </div>;
}
