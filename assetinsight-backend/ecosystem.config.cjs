const os = require("node:os");

const cpuCount =
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
const constrainedMemoryBytes =
  typeof process.constrainedMemory === "function"
    ? Number(process.constrainedMemory() || 0)
    : 0;
const usableMemoryBytes =
  constrainedMemoryBytes > 0
    ? Math.min(os.totalmem(), constrainedMemoryBytes)
    : os.totalmem();
const memoryGiB = usableMemoryBytes / 1024 ** 3;
// Each report worker deliberately executes one report at a time because PDF,
// DOCX, ZIP, and image processing have sizeable independent memory peaks.
const safeDefaultWorkerInstances = Math.max(
  1,
  Math.min(6, Math.floor(cpuCount / 4), Math.floor(memoryGiB / 8))
);
const configuredWorkerInstances = Number.parseInt(
  String(process.env.REPORT_WORKER_INSTANCES || safeDefaultWorkerInstances),
  10
);
const reportWorkerInstances = Math.max(
  1,
  Math.min(
    safeDefaultWorkerInstances,
    Number.isFinite(configuredWorkerInstances)
      ? configuredWorkerInstances
      : safeDefaultWorkerInstances
  )
);
const configuredReportLeaseMs = Number.parseInt(
  String(process.env.REPORT_JOB_LEASE_MS || 600_000),
  10
);
const reportJobLeaseMs = Math.max(
  600_000,
  Number.isFinite(configuredReportLeaseMs) ? configuredReportLeaseMs : 600_000
);

module.exports = {
  apps: [
    {
      name: "assetinsight-backend",
      cwd: __dirname,
      script: "dist/index.js",
      // Several legacy report/import progress stores are still process-local.
      // Keep one API process until those stores are moved to MongoDB; enabling
      // PM2 cluster mode before then makes status polling nondeterministic.
      exec_mode: "fork",
      instances: 1,
      wait_ready: true,
      listen_timeout: 15_000,
      kill_timeout: 30_000,
      restart_delay: 2_000,
      min_uptime: "10s",
      max_restarts: 10,
      max_memory_restart: process.env.API_MAX_MEMORY || "4G",
      node_args: "--max-old-space-size=3072",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS Z",
      env: {
        NODE_ENV: "production",
        // Production traffic reaches Express through the same-host Nginx
        // reverse proxy. Trust exactly that one hop so req.ip is the client
        // address supplied by Nginx instead of its 127.0.0.1 socket address.
        TRUST_PROXY_HOPS: process.env.TRUST_PROXY_HOPS || "1",
        REPORT_PROCESS_ROLE: "api",
        REPORT_QUEUE_BACKEND: "mongo",
        REPORT_DOCX_MERGE_MODE:
          process.env.REPORT_DOCX_MERGE_MODE || "groupdocs",
        REPORT_JOB_LEASE_MS: process.env.REPORT_JOB_LEASE_MS || "180000",
        REPORT_JOB_HEARTBEAT_MS: process.env.REPORT_JOB_HEARTBEAT_MS || "30000",
        HTTP_LISTEN_BACKLOG: process.env.HTTP_LISTEN_BACKLOG || "8192",
        MONGODB_MAX_POOL_SIZE: process.env.API_MONGODB_MAX_POOL_SIZE || "40",
        MONGODB_MIN_POOL_SIZE: process.env.API_MONGODB_MIN_POOL_SIZE || "2",
        REPORT_UPLOAD_COMPLETE_VERIFY_CONCURRENCY:
          process.env.REPORT_UPLOAD_COMPLETE_VERIFY_CONCURRENCY || "4",
        UV_THREADPOOL_SIZE: "16",
      },
    },
    {
      name: "assetinsight-backend-worker",
      cwd: __dirname,
      script: "dist/reportWorker.js",
      exec_mode: "fork",
      // Report jobs are durable and lease-backed in MongoDB, so separate
      // workers can safely use the host's CPU without duplicating reports.
      instances: reportWorkerInstances,
      wait_ready: true,
      listen_timeout: 20_000,
      // Large chunked reports can legitimately spend several minutes merging.
      // Give the active durable job time to finish cleanly during a deploy.
      kill_timeout: 900_000,
      restart_delay: 3_000,
      min_uptime: "10s",
      max_restarts: 10,
      max_memory_restart: process.env.WORKER_MAX_MEMORY || "8G",
      node_args: "--max-old-space-size=6144",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS Z",
      env: {
        NODE_ENV: "production",
        REPORT_PROCESS_ROLE: "worker",
        REPORT_QUEUE_BACKEND: "mongo",
        REPORT_DOCX_MERGE_MODE:
          process.env.REPORT_DOCX_MERGE_MODE || "groupdocs",
        // One heavy report per worker. Scale throughput with isolated worker
        // processes so an old environment override cannot stack Chromiums in
        // the same 8 GiB worker budget.
        REPORT_JOB_CONCURRENCY: "1",
        REPORT_JOB_POLL_MS: process.env.REPORT_JOB_POLL_MS || "2000",
        // A renewable lease leaves headroom for a large in-process PDF merge
        // while still allowing another worker to reclaim an interrupted job.
        REPORT_JOB_LEASE_MS: String(reportJobLeaseMs),
        REPORT_JOB_HEARTBEAT_MS: process.env.REPORT_JOB_HEARTBEAT_MS || "30000",
        ASSET_IMAGE_UPLOAD_CONCURRENCY:
          process.env.ASSET_IMAGE_UPLOAD_CONCURRENCY || "4",
        REPORT_ZIP_FETCH_CONCURRENCY:
          process.env.REPORT_ZIP_FETCH_CONCURRENCY || "4",
        REPORT_IMAGE_FETCH_CONCURRENCY:
          process.env.REPORT_IMAGE_FETCH_CONCURRENCY || "4",
        REPORT_PDF_IMAGE_FETCH_CONCURRENCY:
          process.env.REPORT_PDF_IMAGE_FETCH_CONCURRENCY || "4",
        REPORT_PDF_IMAGE_FETCH_TIMEOUT_MS:
          process.env.REPORT_PDF_IMAGE_FETCH_TIMEOUT_MS || "15000",
        REPORT_PDF_IMAGE_MAX_EDGE_PX:
          process.env.REPORT_PDF_IMAGE_MAX_EDGE_PX || "1200",
        REPORT_PDF_IMAGE_JPEG_QUALITY:
          process.env.REPORT_PDF_IMAGE_JPEG_QUALITY || "80",
        REPORT_PDF_IMAGE_TOTAL_PIXEL_BUDGET:
          process.env.REPORT_PDF_IMAGE_TOTAL_PIXEL_BUDGET || "80000000",
        REPORT_PDF_IMAGE_TOTAL_ENCODED_BYTES:
          process.env.REPORT_PDF_IMAGE_TOTAL_ENCODED_BYTES || "100663296",
        REPORT_PDF_CHUNK_IMAGE_OCCURRENCES:
          process.env.REPORT_PDF_CHUNK_IMAGE_OCCURRENCES || "32",
        REPORT_PDF_CHUNK_RENDER_UNITS:
          process.env.REPORT_PDF_CHUNK_RENDER_UNITS || "8",
        MONGODB_MAX_POOL_SIZE:
          process.env.WORKER_MONGODB_MAX_POOL_SIZE || "12",
        MONGODB_MIN_POOL_SIZE:
          process.env.WORKER_MONGODB_MIN_POOL_SIZE || "1",
        UV_THREADPOOL_SIZE: "8",
      },
    },
  ],
};
