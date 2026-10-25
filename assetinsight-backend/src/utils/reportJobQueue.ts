import { getPositiveIntEnv } from "./concurrency.js";

type ReportJobTask = () => Promise<void> | void;

const reportJobConcurrency = getPositiveIntEnv("REPORT_JOB_CONCURRENCY", 2);
const pendingJobs: Array<{ name: string; task: ReportJobTask }> = [];
let activeJobs = 0;

function drainReportQueue() {
  while (activeJobs < reportJobConcurrency && pendingJobs.length > 0) {
    const next = pendingJobs.shift();
    if (!next) return;

    activeJobs += 1;
    Promise.resolve()
      .then(() => next.task())
      .catch((error) => {
        console.error(`[ReportJobQueue] ${next.name} failed:`, error);
      })
      .finally(() => {
        activeJobs -= 1;
        drainReportQueue();
      });
  }
}

export function enqueueReportJob(name: string, task: ReportJobTask) {
  pendingJobs.push({ name, task });
  drainReportQueue();
}

export function getReportJobQueueStats() {
  return {
    active: activeJobs,
    pending: pendingJobs.length,
    concurrency: reportJobConcurrency,
  };
}
