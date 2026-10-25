import Link from "next/link";
import type { WorkspaceNotification } from "@/services/notifications";
import { previewReminderDetails } from "@/lib/previewReminderNotification";
import styles from "./NotificationModal.module.css";

export default function PreviewReminderContent({ item, onOpenPreview }: {
  item: WorkspaceNotification;
  onOpenPreview?: () => void;
}) {
  const detail = previewReminderDetails(item);
  if (!detail) return null;
  return <section className={styles.message} aria-label="Report notification details">
    <h3>{detail.subject}</h3>
    <dl className={styles.messageMeta}>
      <div><dt>From</dt><dd>Asset Insight Operations</dd></div>
      <div><dt>Report</dt><dd>{detail.reportLabel}{detail.contractNo ? ` · ${detail.contractNo}` : ""}</dd></div>
    </dl>
    <p className={styles.messageText}>{detail.message}</p>
    {detail.reportError ? <div className={styles.messageIssue}>
      <h4>Reported issue</h4><p className={styles.messageText}>{detail.reportError}</p>
    </div> : null}
    {detail.correctionSteps.length ? <div>
      <h4>What to do next</h4><ol>{detail.correctionSteps.map((step, index) => <li key={index}>{step}</li>)}</ol>
    </div> : null}
    <p className={styles.messageNote}>This message records the report state when it was sent. Open the preview to check the latest status.</p>
    {detail.previewHref ? <Link className={styles.previewLink} href={detail.previewHref} prefetch={false} onClick={onOpenPreview}>{detail.linkLabel}</Link>
      : <p className={styles.messageNote}>A valid related preview link is not available. Find the report in Previews or contact Operations.</p>}
  </section>;
}
