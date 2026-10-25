export type ReportWorkerSignal = "SIGINT" | "SIGTERM";

export type ReportWorkerProcessRuntime = {
  once: (signal: ReportWorkerSignal, listener: () => void) => unknown;
  removeListener: (signal: ReportWorkerSignal, listener: () => void) => unknown;
  send?: (message: string) => unknown;
  exit: (code: number) => unknown;
};

export type ReportWorkerProcessDependencies = {
  connectDB: () => Promise<void>;
  disconnectDB: () => Promise<void>;
  startMaintenance: () => void;
  runWorker: (signal: AbortSignal) => Promise<void>;
};

/**
 * Owns the report worker process lifecycle from signal registration through
 * the final process exit. A stop signal prevents new claims, while runWorker
 * remains responsible for finishing any job it already leased.
 *
 * PM2 keeps a referenced IPC channel in its fork-process container. Once an
 * application installs a signal listener, Node no longer performs the default
 * signal exit, so returning from the worker loop is not enough. Exiting only
 * after runWorker and disconnectDB resolve preserves in-flight work and closes
 * MongoDB cleanly without waiting for PM2's kill_timeout.
 */
export async function runReportWorkerProcess(
  dependencies: ReportWorkerProcessDependencies,
  runtime: ReportWorkerProcessRuntime = process
): Promise<void> {
  const shutdownController = new AbortController();
  let exitCode = 0;

  const requestShutdown = (signal: ReportWorkerSignal) => {
    if (shutdownController.signal.aborted) return;
    console.log(`[ReportWorker] ${signal} received; draining active jobs`);
    shutdownController.abort();
  };
  const onSigint = () => requestShutdown("SIGINT");
  const onSigterm = () => requestShutdown("SIGTERM");

  // Register before connecting or reporting readiness so a deploy cannot land
  // in a window where PM2 has started stopping a worker that cannot yet drain.
  runtime.once("SIGINT", onSigint);
  runtime.once("SIGTERM", onSigterm);

  try {
    await dependencies.connectDB();

    if (!shutdownController.signal.aborted) {
      dependencies.startMaintenance();
      runtime.send?.("ready");
      await dependencies.runWorker(shutdownController.signal);
    }
  } catch (error) {
    exitCode = 1;
    console.error("[ReportWorker] Fatal error:", error);
  } finally {
    try {
      await dependencies.disconnectDB();
    } catch (error) {
      exitCode = 1;
      console.error("[ReportWorker] MongoDB disconnect failed:", error);
    }

    runtime.removeListener("SIGINT", onSigint);
    runtime.removeListener("SIGTERM", onSigterm);
    runtime.exit(exitCode);
  }
}
