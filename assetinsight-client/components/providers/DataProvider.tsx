"use client";

import { SWRConfig } from "swr";

export function DataProvider({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        dedupingInterval: 10_000,
        errorRetryCount: 2,
        focusThrottleInterval: 15_000,
        keepPreviousData: true,
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
        shouldRetryOnError: (error: unknown) => {
          const status = (error as { response?: { status?: number } })?.response
            ?.status;
          return status !== 401 && status !== 403 && status !== 404;
        },
        isPaused: () =>
          typeof navigator !== "undefined" && navigator.onLine === false,
      }}
    >
      {children}
    </SWRConfig>
  );
}
