"use client";

import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

export type PreviewMutationKind = "save" | "submit" | "upload";

export type PreviewMutationLease = {
  id: number;
  kind: PreviewMutationKind;
  editRevision: number;
};

/**
 * A React loading flag is not synchronous, so two discrete events can both
 * enter an async handler before the disabled state is committed. This hook
 * keeps the user-visible state and an immediate ref lock together. Every
 * preview write must acquire the same lock before starting.
 */
export function useExclusivePreviewMutation() {
  const nextLeaseIdRef = useRef(0);
  const mutationRef = useRef<PreviewMutationLease | null>(null);
  const editRevisionRef = useRef(0);
  const hasChangesRef = useRef(false);
  const [activeMutation, setActiveMutation] =
    useState<PreviewMutationKind | null>(null);
  const [hasChanges, setHasChangesState] = useState(false);

  const setHasChanges = useCallback<Dispatch<SetStateAction<boolean>>>(
    (nextValue) => {
      const next =
        typeof nextValue === "function"
          ? nextValue(hasChangesRef.current)
          : nextValue;
      if (next) editRevisionRef.current += 1;
      hasChangesRef.current = next;
      setHasChangesState(next);
    },
    []
  );

  const beginMutation = useCallback((kind: PreviewMutationKind) => {
    if (mutationRef.current) return null;
    const lease: PreviewMutationLease = {
      id: nextLeaseIdRef.current + 1,
      kind,
      editRevision: editRevisionRef.current,
    };
    nextLeaseIdRef.current = lease.id;
    mutationRef.current = lease;
    setActiveMutation(kind);
    return lease;
  }, []);

  const finishMutation = useCallback((lease: PreviewMutationLease) => {
    if (mutationRef.current?.id !== lease.id) return;
    mutationRef.current = null;
    setActiveMutation(null);
  }, []);

  const isMutationLocked = useCallback(() => mutationRef.current !== null, []);
  const hasEditsSince = useCallback(
    (lease: PreviewMutationLease) =>
      editRevisionRef.current !== lease.editRevision,
    []
  );

  return {
    activeMutation,
    beginMutation,
    finishMutation,
    hasChanges,
    hasEditsSince,
    isMutationLocked,
    setHasChanges,
  };
}
