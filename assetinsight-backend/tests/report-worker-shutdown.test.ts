import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runReportWorkerProcess } from "../src/bootstrap/reportWorkerProcess.js";
import ReportJob from "../src/models/reportJob.model.js";
import { startMongoReportWorker } from "../src/utils/reportJobMongoQueue.js";

const originalWorkerEnvironment = {
  REPORT_JOB_CONCURRENCY: process.env.REPORT_JOB_CONCURRENCY,
  REPORT_JOB_POLL_MS: process.env.REPORT_JOB_POLL_MS,
  REPORT_JOB_LEASE_MS: process.env.REPORT_JOB_LEASE_MS,
  REPORT_JOB_HEARTBEAT_MS: process.env.REPORT_JOB_HEARTBEAT_MS,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeWorkerRuntime extends EventEmitter {
  readonly sent: string[] = [];
  readonly exits: number[] = [];

  send(message: string) {
    this.sent.push(message);
  }

  exit(code: number) {
    this.exits.push(code);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalWorkerEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("report worker graceful shutdown", () => {
  it("interrupts a long idle poll as soon as shutdown is requested", async () => {
    process.env.REPORT_JOB_CONCURRENCY = "1";
    process.env.REPORT_JOB_POLL_MS = "60000";

    vi.spyOn(ReportJob, "find").mockReturnValue({
      sort: () => ({ limit: () => Promise.resolve([]) }),
    } as never);
    const claim = vi
      .spyOn(ReportJob, "findOneAndUpdate")
      .mockResolvedValue(null as never);
    const controller = new AbortController();

    const worker = startMongoReportWorker(
      { "asset-preview": vi.fn() },
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1));

    controller.abort();
    await expect(worker).resolves.toBeUndefined();
  });

  it("finishes a job already claimed before resolving shutdown", async () => {
    process.env.REPORT_JOB_CONCURRENCY = "1";
    process.env.REPORT_JOB_POLL_MS = "60000";
    process.env.REPORT_JOB_LEASE_MS = "600000";
    process.env.REPORT_JOB_HEARTBEAT_MS = "30000";

    const inFlightJob = deferred();
    const handlerStarted = deferred();
    const job = {
      _id: "worker-shutdown-job",
      type: "asset-preview",
      attempts: 1,
      maxAttempts: 2,
      executionToken: "worker-shutdown-attempt",
      payload: {},
    };

    vi.spyOn(ReportJob, "find").mockReturnValue({
      sort: () => ({ limit: () => Promise.resolve([]) }),
    } as never);
    vi.spyOn(ReportJob, "findOneAndUpdate")
      .mockResolvedValueOnce(job as never)
      .mockResolvedValueOnce({ _id: job._id } as never);
    const handler = vi.fn(async () => {
      handlerStarted.resolve();
      await inFlightJob.promise;
    });
    const controller = new AbortController();
    let workerResolved = false;

    const worker = startMongoReportWorker(
      { "asset-preview": handler },
      { signal: controller.signal }
    ).then(() => {
      workerResolved = true;
    });
    await handlerStarted.promise;

    controller.abort();
    await Promise.resolve();
    expect(workerResolved).toBe(false);

    inFlightJob.resolve();
    await worker;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(workerResolved).toBe(true);
  });

  it("disconnects MongoDB before explicitly exiting the PM2 process", async () => {
    const runtime = new FakeWorkerRuntime();
    const inFlightJob = deferred();
    const workerStarted = deferred();
    const events: string[] = [];

    const lifecycle = runReportWorkerProcess(
      {
        connectDB: async () => {
          events.push("connected");
        },
        startMaintenance: () => {
          events.push("maintenance-started");
        },
        runWorker: async (signal) => {
          events.push("worker-started");
          workerStarted.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                events.push("shutdown-requested");
                void inFlightJob.promise.then(resolve);
              },
              { once: true }
            );
          });
          events.push("worker-drained");
        },
        disconnectDB: async () => {
          events.push("disconnected");
        },
      },
      runtime
    );
    await workerStarted.promise;
    expect(runtime.sent).toEqual(["ready"]);

    runtime.emit("SIGTERM");
    await Promise.resolve();
    expect(events).not.toContain("disconnected");
    expect(runtime.exits).toEqual([]);

    inFlightJob.resolve();
    await lifecycle;

    expect(events).toEqual([
      "connected",
      "maintenance-started",
      "worker-started",
      "shutdown-requested",
      "worker-drained",
      "disconnected",
    ]);
    expect(runtime.exits).toEqual([0]);
  });
});
