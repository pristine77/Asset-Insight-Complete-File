"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "@/components/ui/toast";
import { captureAuthSession, isAuthSessionCurrent, type AuthSessionSnapshot } from "@/lib/auth-storage";
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

type CurrencyIntent = {
  id: number;
  contextKey: string;
  targetCurrency: string;
  authSession: AuthSessionSnapshot;
};
type CompletedConversion = {
  contextKey: string;
  generation: number;
  intentId: number;
  previewData: any;
  authSession: AuthSessionSnapshot;
  quote: CurrencyQuote;
};

export function usePreviewCurrencyConversion(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const nextIntentId = useRef(0);
  const intentRef = useRef<CurrencyIntent | null>(null);
  const [intentState, setIntentState] = useState<CurrencyIntent | null>(null);
  const completedRef = useRef<CompletedConversion | null>(null);
  const [completed, setCompleted] = useState<CompletedConversion | null>(null);
  useEffect(() => {
    generation.current += 1;
    intentRef.current = null;
    completedRef.current = null;
    return () => {
      generation.current += 1;
      intentRef.current = null;
      completedRef.current = null;
      controller.current?.abort();
    };
  }, [options.contextKey, options.isOpen]);

  // Keep the synchronous Save guard armed until React has applied the exact
  // converted snapshot. Releasing the mutation lease alone must not permit a
  // Save closure that still sees the previous currency.
  useEffect(() => {
    if (completedRef.current?.intentId === intentRef.current?.id &&
      completedRef.current?.previewData === options.previewData) intentRef.current = null;
  }, [options.previewData]);

  function currentIntent() {
    const intent = intentRef.current;
    return latest.current.isOpen && intent?.contextKey === latest.current.contextKey ? intent : null;
  }

  function isCurrencyPending() {
    const intent = currentIntent();
    return Boolean(intent && intent.targetCurrency !== (latest.current.previewData?.currency || "CAD"));
  }

  async function performConversion(intent: CurrencyIntent) {
    const current = latest.current;
    const snapshot = current.previewData;
    const targetCurrency = intent.targetCurrency;
    if (!current.isOpen || current.disabled || !snapshot || targetCurrency === (snapshot.currency || "CAD") ||
      currentIntent()?.id !== intent.id) return;
    if (!isAuthSessionCurrent(intent.authSession)) {
      toast.error("Your account changed. Reopen this report before converting its currency.");
      return;
    }
    const mutation = current.beginMutation("currency");
    if (!mutation) return;
    const requestGeneration = generation.current;
    const authSession = intent.authSession;
    const abort = new AbortController();
    controller.current = abort;
    const isCurrent = () => currentIntent()?.id === intent.id && requestGeneration === generation.current &&
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
      const completion = { contextKey: current.contextKey, generation: requestGeneration, intentId: intent.id,
        previewData: converted.preview_data, authSession, quote: converted.quote };
      completedRef.current = completion;
      setCompleted(completion);
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

  function chooseTarget(targetCurrency: string) {
    const current = latest.current;
    if (!current.isOpen) return null;
    controller.current?.abort();
    const intent = targetCurrency === (current.previewData?.currency || "CAD") ? null : {
      id: ++nextIntentId.current,
      contextKey: current.contextKey,
      targetCurrency,
      authSession: captureAuthSession(),
    };
    intentRef.current = intent;
    setIntentState(intent);
    return intent;
  }

  function selectCurrency(targetCurrency: string) {
    const intent = chooseTarget(targetCurrency);
    if (intent) void performConversion(intent);
  }

  async function convertCurrency(targetCurrency?: string) {
    let intent = currentIntent();
    if (targetCurrency !== undefined && intent?.targetCurrency !== targetCurrency) intent = chooseTarget(targetCurrency);
    if (intent) await performConversion(intent);
  }

  const visibleIntent = options.isOpen && intentState?.contextKey === options.contextKey &&
    intentState.id === intentRef.current?.id ? intentState : null;
  const currencyTarget = visibleIntent?.targetCurrency || options.previewData?.currency || "CAD";
  const currencyPending = currencyTarget !== (options.previewData?.currency || "CAD");
  return { convertCurrency, selectCurrency, currencyTarget, currencyPending, isCurrencyPending,
    currencyQuote: options.isOpen && !currencyPending && completed?.contextKey === options.contextKey &&
      completed.generation === generation.current && isAuthSessionCurrent(completed.authSession) &&
      completed.quote.toCurrency === options.previewData?.currency ? completed.quote : null };
}
