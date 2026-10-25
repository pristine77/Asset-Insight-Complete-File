import { test, expect } from '@playwright/test';
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || '3010'}`;
// Browser plugin unavailable. Isolated API fixtures only; no report writes.
for (const theme of ['light', 'dark'] as const) test(`preview failures, five processing reports and Submitted (${theme})`, async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 800 });
  const errors: string[] = [], writes: string[] = [], requests: string[] = [];
  let failAsset = true, submitted = false, failLots = false;
  await page.context().addCookies([{ name: 'cv_access_token', value: 'isolated-preview-owner', url: baseURL }]);
  await page.addInitScript(value => { localStorage.setItem('cv_access_token', 'isolated-preview-owner'); localStorage.setItem('cv-theme', value); }, theme);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === baseURL || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    return route.abort();
  });
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (req.method() !== 'GET') writes.push(req.method() + ' ' + path);
    requests.push(path);
    let body: unknown = { data: [], items: [], unreadCount: 0, enabled: false, configured: false, showBadge: false }, status = 200;
    if (path.endsWith('/user/me')) body = { _id: 'owner', username: 'Preview QA', email: 'qa@example.test', isCrmAgent: false };
    else if (path.endsWith('/notifications')) body = [];
    else if (path === '/api/asset') { expect(url.searchParams.get('view')).toBe('previews'); if (failAsset) { status = 503; body = { message: 'Temporary server failure' }; } }
    else if (path === '/api/lot-listing') {
      expect(url.searchParams.get('view')).toBe('previews');
      if (failLots) { status = 502; body = { message: 'Temporary upstream failure' }; }
      else body = { data: Array.from({ length: 5 }, (_, i) => ({ _id: `lot-qa-${i}`, contract_no: `QA-${i + 1}`, status: 'processing', createdAt: '2026-10-02',
        generation_state: 'processing', files_generating: true, workflow_stage: submitted ? 'generating_files' : 'preparing_preview',
        generation_target_status: submitted ? 'approved' : undefined, preview_available: true, lot_count: 2, image_count: 400, currency: 'CAD' })) };
    }
    return route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/previews');
  const issue = page.locator('section[role="alert"]');
  await expect(issue).toContainText('server could not load');
  await expect(page.getByRole('heading', { name: 'QA-1', exact: true })).toBeVisible();
  await expect(page.getByText('No new previews', { exact: true })).toHaveCount(0);
  failAsset = false;
  const retry = page.getByRole('button', { name: 'Retry loading previews' });
  await retry.focus(); await page.keyboard.press('Enter');
  await expect(issue).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'New (5)', exact: true })).toBeVisible();
  submitted = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'View submitted previews (5)' }).click();
  await expect(page.getByRole('tab', { name: 'Submitted (5)' })).toHaveAttribute('aria-selected', 'true');
  failLots = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(issue).toContainText('Lot Listing');
  await expect(page.getByRole('heading', { name: 'QA-1', exact: true })).toBeVisible();
  expect(await page.locator('body').evaluate(el => el.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/assetinsight-preview-audit.a53KCL/previews-${info.project.name}-${theme}.png`, fullPage: true });
  expect(requests).not.toContain('/api/asset/submitted');
  expect(writes).toEqual([]); expect(errors).toEqual([]);
});
