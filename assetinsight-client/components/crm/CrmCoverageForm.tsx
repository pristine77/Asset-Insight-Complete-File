"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import BottomDrawer from "@/components/BottomDrawer";
import type { AuthUser } from "@/services/auth";
import { CrmService, CRM_SPECIALIZATION_OPTIONS } from "@/services/crm";
import { CRM_QUADRANT_OPTIONS, parseCrmQuadrants } from "./crmAuxiliaryHelpers";
import { useCrmPanelMutation } from "./useCrmPanelMutation";
import styles from "./CrmAuxiliary.module.css";

export type CrmCoverageFormProps = { ownerId: string; user: AuthUser; onClose: () => void; onSaved: (user: AuthUser) => void };

function CoverageForm({ user, onClose, onSaved }: CrmCoverageFormProps) {
  const [address, setAddress] = useState(user.crmAddress || "");
  const [quadrants, setQuadrants] = useState(() => parseCrmQuadrants(user.crmQuadrant));
  const [specializations, setSpecializations] = useState(() => [...(user.crmSpecializations || [])]);
  const mutation = useCrmPanelMutation();
  const close = () => { if (!mutation.isLocked()) onClose(); };
  const toggle = (list: string[], value: string) => list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

  return <BottomDrawer open title="CRM coverage" description="Set the service address, areas and specialties used for lead assignments." onClose={close} closeDisabled={mutation.busy} dismissOnBackdrop={false}>
    <form className={styles.form} onSubmit={(event) => {
      event.preventDefault();
      if (mutation.isLocked()) return;
      if (!address.trim() || !quadrants.length || !specializations.length) { mutation.setError("Enter a service address and select at least one coverage area and specialization."); return; }
      void mutation.run((signal) => CrmService.updateCoverage({ crmAddress: address.trim(), crmQuadrant: quadrants, crmSpecializations: specializations }, { signal }), onSaved);
    }}>
      <fieldset className={styles.fields} disabled={mutation.busy}>
        <label className="app-label">Service address<textarea className="app-field" required rows={3} autoComplete="street-address" value={address} onChange={(event) => setAddress(event.target.value)} /></label>
        <fieldset className={styles.choiceGroup}>
          <legend>Coverage areas <span className={styles.optional}>Select one or more</span></legend>
          <div className={styles.choices}>{CRM_QUADRANT_OPTIONS.map((option) => <label className={styles.choice} key={option.value}>
            <input type="checkbox" checked={quadrants.includes(option.value)} onChange={() => setQuadrants((current) => toggle(current, option.value))} /><span>{option.label}</span>
          </label>)}</div>
        </fieldset>
        <fieldset className={styles.choiceGroup}>
          <legend>Specializations <span className={styles.optional}>Select one or more</span></legend>
          <div className={styles.specializations}>{CRM_SPECIALIZATION_OPTIONS.map((option) => <label className={styles.choice} key={option.value}>
            <input type="checkbox" checked={specializations.includes(option.value)} onChange={() => setSpecializations((current) => toggle(current, option.value))} /><span>{option.label}</span>
          </label>)}</div>
        </fieldset>
      </fieldset>
      {mutation.error ? <div className="app-alert app-alert--error" role="alert"><div>{mutation.error}{mutation.uncertain ? <p className={styles.errorHint}>Your entries are kept. The save may have completed; reload the page to check saved coverage before trying again.</p> : null}</div></div> : null}
      <footer className={styles.footer}>
        <button className="app-button app-button--secondary" type="button" onClick={close} disabled={mutation.busy}>Cancel</button>
        <button className="app-button app-button--primary" type="submit" disabled={mutation.busy}>{mutation.busy ? <span className="app-spinner" aria-hidden /> : <Check size={16} aria-hidden />}{mutation.busy ? "Saving…" : "Save coverage"}</button>
      </footer>
    </form>
  </BottomDrawer>;
}

export default function CrmCoverageForm(props: CrmCoverageFormProps) {
  return <CoverageForm key={props.ownerId} {...props} />;
}
