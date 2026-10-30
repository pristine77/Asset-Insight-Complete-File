"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "@/components/ui/toast";
import { captureAuthSession, isAuthSessionCurrent } from "@/lib/auth-storage";
import { convertPreviewCurrency, type CurrencyQuote } from "@/services/reportCurrency";
import type { PreviewMutationKind, PreviewMutationLease } from "./useExclusivePreviewMutation";

type Options = {
  kind: "asset" | "lot-listing";
  reportId: string;
  isOpen: boolean;
  contextKey: string;
  assignedApproval: boolean;
  disabled: boolean;
  previewData: any;
  setPreviewData: Dispatch<SetStateAction<any>>;
  setHasChanges: Dispatch<SetStateAction<boolean>>;
  beginMutation: (kind: PreviewMutationKind) => PreviewMutationLease | null;
  finishMutation: (lease: PreviewMutationLease) => void;
  hasEditsSince: (lease: PreviewMutationLease) => boolean;
};

export function usePreviewCurrencyConversion(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [completed, setCompleted] = useState<{ contextKey: string; quote: CurrencyQuote } | null>(null);
  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
      controller.current?.abort();
    };
  }, [options.contextKey, options.isOpen]);

  async function convert(targetCurrency: string) {
    const current = latest.current;
    const snapshot = current.previewData;
    if (!current.isOpen || current.disabled || !snapshot || targetCurrency === (snapshot.currency || "CAD")) return;
    const mutation = current.beginMutation("currency");
    if (!mutation) return;
    const requestGeneration = generation.current;
    const authSession = captureAuthSession();
    const abort = new AbortController();
    controller.current = abort;
    const isCurrent = () => requestGeneration === generation.current &&
      current.contextKey === latest.current.contextKey && latest.current.isOpen && !abort.signal.aborted && isAuthSessionCurrent(authSession);
    try {
      const converted = await convertPreviewCurrency(current.kind, current.reportId, targetCurrency,
        { ...snapshot, currency: snapshot.currency || "CAD" },
        { assignedApproval: current.assignedApproval, signal: abort.signal });
      if (!isCurrent()) return;
      if (current.hasEditsSince(mutation) || latest.current.previewData !== snapshot) {
        toast.info("Your preview changed during conversion. Try again to include the latest edits.");
        return;
      }
      current.setPreviewData(converted.preview_data);
      current.setHasChanges(true);
      setCompleted({ contextKey: current.contextKey, quote: converted.quote });
      toast.success("Currency and amounts converted. Save to update the report files.");
    } catch (error: unknown) {
      if (!isCurrent()) return;
      const candidate = error as { response?: { data?: { message?: unknown } }; message?: unknown };
      const message = candidate.response?.data?.message ?? candidate.message;
      toast.error(typeof message === "string" ? message : "Currency conversion is unavailable. Your values have not changed.");
    } finally {
      if (controller.current === abort) controller.current = null;
      current.finishMutation(mutation);
    }
  }
  return { convertCurrency: convert, currencyQuote: options.isOpen && completed?.contextKey === options.contextKey &&
    completed.quote.toCurrency === options.previewData?.currency ? completed.quote : null };
}
