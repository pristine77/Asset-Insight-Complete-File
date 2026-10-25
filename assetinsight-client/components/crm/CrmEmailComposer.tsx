"use client";

import { ArrowLeft, Mail, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import CrmService, { crmErrorMessage } from "@/services/crm";
import { crmEmailHref, crmEmailPlainText, type CrmDetailUser } from "./crmDetailHelpers";
import { useCrmVoiceInput } from "./useCrmVoiceInput";
import CrmVoiceControls from "./CrmVoiceControls";
import { useCrmOnline } from "./useCrmRead";
import styles from "./CrmTaskDetail.module.css";

type Props = {
  clientName: string;
  email?: string;
  user: CrmDetailUser;
  onBack: () => void;
  onDirtyChange?: (dirty: boolean) => void;
};

export default function CrmEmailComposer({ clientName, email, user, onBack, onDirtyChange }: Props) {
  const [to, setTo] = useState(email || "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [rewriting, setRewriting] = useState(false);
  const [rewritten, setRewritten] = useState(false);
  const rewriteLock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const online = useCrmOnline();
  const voice = useCrmVoiceInput({
    transcribe: (audio, signal) => CrmService.transcribeCommentAudio({ audio }, { signal }),
    onText: (text) => setBody((current) => current.trim() ? `${current}\n${text}` : text),
  });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  useEffect(() => { onDirtyChange?.(Boolean(body || subject || to !== (email || "") || voice.busy || rewriting)); }, [body, subject, to, email, voice.busy, rewriting, onDirtyChange]);
  useEffect(() => { if (!online) voice.cancel(); }, [online]);

  async function rewrite() {
    if (rewriteLock.current || voice.busy) return;
    if (!online) { setError("Reconnect before rewriting or transcribing your email."); return; }
    if (!body.trim()) { setError("Write or dictate an email before using Software rewrite."); return; }
    rewriteLock.current = true;
    const request = new AbortController();
    controller.current = request;
    setRewriting(true);
    setError("");
    try {
      const result = await CrmService.rewriteEmailWithAI({
        body: body.trim(), subject: subject.trim() || undefined, clientName,
        senderName: user.name, senderCompany: user.company,
      }, { signal: request.signal });
      if (!mounted.current || request.signal.aborted) return;
      setSubject(crmEmailPlainText(result.subject));
      setBody(crmEmailPlainText(result.body));
      setRewritten(true);
    } catch (cause) {
      if (mounted.current && !request.signal.aborted) setError(crmErrorMessage(cause, "Could not rewrite the email."));
    } finally {
      rewriteLock.current = false;
      if (mounted.current) setRewriting(false);
    }
  }

  let href: string | undefined;
  try { href = crmEmailHref(to, subject, body, user); } catch { /* validation is shown on explicit handoff */ }

  return (
    <section className={styles.section} aria-label="Compose email">
      <button type="button" className={styles.textButton} onClick={onBack}><ArrowLeft size={16} aria-hidden />Back to task</button>
      <h3 className={styles.sectionTitle}>Compose email</h3>
      <p className={styles.muted}>Review your draft, then open it in your email app.</p>
      <div className={styles.editor}>
        <label className={styles.field}>Recipient email<input className="app-field" type="email" value={to} onChange={(event) => setTo(event.target.value)} disabled={rewriting} autoComplete="email" /></label>
        <label className={styles.field}>Subject<input className="app-field" value={subject} onChange={(event) => setSubject(event.target.value)} disabled={rewriting} /></label>
        <label className={styles.field}>Message<textarea className={`app-field ${styles.emailBody}`} value={body} onChange={(event) => setBody(event.target.value)} disabled={rewriting} placeholder="Write an email or record a note…" /></label>
        <div className={styles.tools}>
          <CrmVoiceControls voice={voice} disabled={rewriting || !online} />
          <button type="button" className={styles.textButton} disabled={rewriting || !online || voice.busy} onClick={() => void rewrite()}><WandSparkles size={17} aria-hidden />{rewriting ? "Rewriting…" : "Software rewrite"}</button>
        </div>
        {rewritten ? <p className={styles.muted} role="status">Draft rewritten. Review the editable text before opening your email app.</p> : null}
        {user.name || user.company || user.phone || user.email ? <p className={styles.muted}>Signature: {[user.name, user.company, user.phone, user.email].filter(Boolean).join(" · ")}</p> : null}
        {error ? <p className="app-alert app-alert--error" role="alert">{error}</p> : null}
        <a className={`app-button app-button--primary ${styles.fullButton}`} href={!rewriting && !voice.busy ? href : undefined}
          aria-disabled={rewriting || voice.busy} onClick={(event) => {
            if (rewriting || voice.busy || !href) {
              event.preventDefault();
              if (!href) setError("Enter a valid recipient email address.");
            }
          }}><Mail size={17} aria-hidden />Open email app</a>
      </div>
    </section>
  );
}
