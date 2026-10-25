"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import BottomDrawer from "@/components/BottomDrawer";
import { CrmService, CRM_SPECIALIZATION_OPTIONS, type CrmSpecializationValue } from "@/services/crm";
import { defaultCrmDueDate } from "./crmAuxiliaryHelpers";
import { useCrmPanelMutation } from "./useCrmPanelMutation";
import styles from "./CrmAuxiliary.module.css";

export type CrmLeadFormProps = { ownerId: string; onClose: () => void; onCreated: (taskId: string) => void };

function LeadForm({ onClose, onCreated }: CrmLeadFormProps) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [specialization, setSpecialization] = useState<CrmSpecializationValue | "">("");
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState(defaultCrmDueDate);
  const mutation = useCrmPanelMutation();
  const close = () => { if (!mutation.isLocked()) onClose(); };

  return <BottomDrawer open title="Add lead" description="Create a lead and its first follow-up task." onClose={close} closeDisabled={mutation.busy} dismissOnBackdrop={false}>
    <form className={styles.form} onSubmit={(event) => {
      event.preventDefault();
      if (mutation.isLocked()) return;
      if (!name.trim() || !phone.trim() || !specialization) { mutation.setError("Enter a name, phone number and specialization."); return; }
      const parsedDate = new Date(dueDate);
      if (!dueDate || !Number.isFinite(parsedDate.getTime())) { mutation.setError("Choose a valid due date and time."); return; }
      void mutation.run((signal) => CrmService.quickAddLead({ name: name.trim(), phone: phone.trim(), specialization, notes: notes.trim() || undefined, dueDate: parsedDate.toISOString() }, { signal }), (task) => onCreated(task._id));
    }}>
      <fieldset className={styles.fields} disabled={mutation.busy}>
        <div className={styles.twoColumns}>
          <label className="app-label">Name<input className="app-field" required autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="app-label">Phone<input className="app-field" type="tel" required autoComplete="off" value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
        </div>
        <label className="app-label">Specialization<select className="app-field" required value={specialization} onChange={(event) => setSpecialization(event.target.value as CrmSpecializationValue)}>
          <option value="">Select specialization</option>
          {CRM_SPECIALIZATION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <label className="app-label">Due date and time<input className="app-field" type="datetime-local" required value={dueDate} onChange={(event) => setDueDate(event.target.value)} /><span className={styles.hint}>Shown in your local time.</span></label>
        <label className="app-label">Notes <span className={styles.optional}>Optional</span><textarea className="app-field" rows={5} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      </fieldset>
      {mutation.error ? <div className="app-alert app-alert--error" role="alert"><div>{mutation.error}{mutation.uncertain ? <p className={styles.errorHint}>Your entries are kept. Check your task list before trying again; the lead may already have been created.</p> : null}</div></div> : null}
      <footer className={styles.footer}>
        <button className="app-button app-button--secondary" type="button" onClick={close} disabled={mutation.busy}>Cancel</button>
        <button className="app-button app-button--primary" type="submit" disabled={mutation.busy}>{mutation.busy ? <span className="app-spinner" aria-hidden /> : <Plus size={16} aria-hidden />}{mutation.busy ? "Creating…" : "Create lead"}</button>
      </footer>
    </form>
  </BottomDrawer>;
}

export default function CrmLeadForm(props: CrmLeadFormProps) {
  return <LeadForm key={props.ownerId} {...props} />;
}
