/** Optional appraiser-authored context, never a substitute for verified evidence. */
export interface SalvageReportContext {
  intended_use?: string | null;
  scope_of_work?: string | null;
  valuation_premise?: string | null;
  pre_loss_condition?: string | null;
  inspection_basis?: string | null;
  repair_estimate_status?: string | null;
  repair_estimate_date?: string | null;
  lead_time_notes?: string | null;
  market_context?: string | null;
  reconciliation_notes?: string | null;
  appraiser_conclusion?: string | null;
  client_comments?: string | null;
}

/** Server-produced presentation of saved evidence/calculations; never sent in edits. */
export interface SalvageReportEnrichment {
  readonly schemaVersion: 1;
  readonly sections: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly paragraphs: readonly string[];
    readonly tables: ReadonlyArray<{
      readonly headers: readonly string[];
      readonly rows: ReadonlyArray<readonly string[]>;
    }>;
  }>;
}
