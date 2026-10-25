"use client";

import { useEffect, useSyncExternalStore } from "react";
import useSWR, { useSWRConfig } from "swr";

type SharedRead = { subscribers: number; controller?: AbortController };
const pools = new WeakMap<object, Map<string, SharedRead>>();
function readPool(cache: object) {
  let pool = pools.get(cache);
  if (!pool) { pool = new Map(); pools.set(cache, pool); }
  return pool;
}
function sharedRead(pool: Map<string, SharedRead>, key: string) {
  let entry = pool.get(key);
  if (!entry) { entry = { subscribers: 0 }; pool.set(key, entry); }
  return entry;
}

const subscribeOnline = (listener: () => void) => {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
};
export function useCrmOnline() {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

/** Callers include the owner and all query arguments in the cache key. */
export function useCrmRead<T>(key: string | null, read: (signal: AbortSignal) => Promise<T>) {
  const { cache } = useSWRConfig();
  const pool = readPool(cache);
  useEffect(() => {
    if (!key) return;
    const entry = sharedRead(pool, key);
    entry.subscribers++;
    return () => {
      entry.subscribers--;
      // StrictMode immediately re-subscribes; another panel may also share this
      // SWR request. Cancel only after the final consumer has actually left.
      queueMicrotask(() => {
        if (entry.subscribers === 0 && pool.get(key) === entry) {
          entry.controller?.abort();
          pool.delete(key);
        }
      });
    };
  }, [key, pool]);
  const result = useSWR(key, async (requestKey: string) => {
    const entry = sharedRead(pool, requestKey);
    entry.controller?.abort();
    const controller = new AbortController();
    entry.controller = controller;
    try {
      const value = await read(controller.signal);
      if (controller.signal.aborted) throw new DOMException("Request cancelled", "AbortError");
      return { value, receivedAt: Date.now() };
    } finally {
      if (entry.controller === controller) entry.controller = undefined;
    }
  }, {
    keepPreviousData: false,
    shouldRetryOnError: false,
    refreshInterval: 0,
    dedupingInterval: 10_000,
  });
  const status = (result.error as { response?: { status?: number } } | undefined)?.response?.status;
  const denied = status === 401 || status === 403 || status === 404;
  return { ...result, data: denied ? undefined : result.data?.value, receivedAt: denied ? undefined : result.data?.receivedAt };
}
