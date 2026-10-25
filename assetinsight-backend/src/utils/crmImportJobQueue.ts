import { getPositiveIntEnv } from "./concurrency.js";

type CrmImportJobTask = () => Promise<void> | void;

const crmImportJobConcurrency = getPositiveIntEnv("CRM_IMPORT_JOB_CONCURRENCY", 1);
const pendingJobs: Array<{ name: string; task: CrmImportJobTask }> = [];
let activeJobs = 0;

function drainCrmImportQueue() {
  while (activeJobs < crmImportJobConcurrency && pendingJobs.length > 0) {
    const next = pendingJobs.shift();
    if (!next) return;

    activeJobs += 1;
    Promise.resolve()
      .then(() => next.task())
      .catch((error) => {
        console.error(`[CrmImportJobQueue] ${next.name} failed:`, error);
      })
      .finally(() => {
        activeJobs -= 1;
        drainCrmImportQueue();
      });
  }
}

export function enqueueCrmImportJob(name: string, task: CrmImportJobTask) {
  pendingJobs.push({ name, task });
  drainCrmImportQueue();
}

export function getCrmImportJobQueueStats() {
  return {
    active: activeJobs,
    pending: pendingJobs.length,
    concurrency: crmImportJobConcurrency,
  };
}
