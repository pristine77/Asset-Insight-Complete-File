import type { Page } from "puppeteer";

const ONE_HOUR_MS = 60 * 60 * 1000;

function readPositiveTimeout(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ONE_HOUR_MS;
}

/**
 * Large reports can contain hundreds of remote images. Puppeteer must be able
 * to wait for those resources without falling back to its 30-second default.
 */
export const PUPPETEER_NAVIGATION_TIMEOUT_MS = readPositiveTimeout(
  process.env.PUPPETEER_NAVIGATION_TIMEOUT_MS
);

export function configurePuppeteerPageTimeouts(page: Page): void {
  page.setDefaultNavigationTimeout(PUPPETEER_NAVIGATION_TIMEOUT_MS);
  page.setDefaultTimeout(PUPPETEER_NAVIGATION_TIMEOUT_MS);
}
