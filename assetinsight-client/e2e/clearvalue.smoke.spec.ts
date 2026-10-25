import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

type ThemeMode = "light" | "dark";

const port = process.env.PLAYWRIGHT_PORT || "3010";
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;

const incomingItem = {
  cycleKey: "e2e-cycle-100",
  contractId: "e2e-contract-100",
  contractNo: "CV-E2E-100",
  customerName: "Northfield Plant Ltd",
  eventId: "e2e-event-100",
  eventTitle: "Fleet dispersal",
  eventDate: "2026-08-12T10:00:00.000Z",
  location: "Leeds",
  kind: "scheduleA",
  lotCount: 14,
  status: "available",
};

const reportThumbnailUrl =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='112' viewBox='0 0 160 112'%3E%3Crect width='160' height='112' fill='%23dbeafe'/%3E%3Cpath d='M20 82l32-31 21 18 23-29 44 42z' fill='%232563eb'/%3E%3C/svg%3E";

async function initializeTheme(page: Page, theme: ThemeMode) {
  await page.addInitScript((initialTheme: ThemeMode) => {
    if (!window.localStorage.getItem("cv-theme")) {
      window.localStorage.setItem("cv-theme", initialTheme);
    }
  }, theme);
}

async function mockAuthenticatedApi(
  page: Page,
  {
    approver = true,
    releaseManager = true,
    incomingItems = [incomingItem],
    onIncomingRequest,
    onLocationRequest,
  }: {
    approver?: boolean;
    releaseManager?: boolean;
    incomingItems?: Array<Record<string, unknown>>;
    onIncomingRequest?: (url: URL) => void;
    onLocationRequest?: (body: Record<string, unknown>) => void;
  } = {}
) {
  await page.context().addCookies([
    {
      name: "cv_access_token",
      value: "e2e-access-token",
      url: baseURL,
    },
    {
      name: "cv_refresh_token",
      value: "e2e-refresh-token",
      url: baseURL,
    },
  ]);
  await page.addInitScript(() => {
    window.localStorage.setItem("cv_access_token", "e2e-access-token");
    window.localStorage.setItem("cv_refresh_token", "e2e-refresh-token");
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let body: unknown;

    if (path.endsWith("/proposal-valuation/export")) {
      await route.fulfill({
        status: 200,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "Content-Disposition",
          "content-disposition":
            "attachment; filename*=UTF-8''E2E%20Proposal%20Valuation.xlsx",
          "content-type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        body: "mock xlsx workbook",
      });
      return;
    }

    if (path.endsWith("/api/location/reverse-geocode")) {
      onLocationRequest?.(
        (request.postDataJSON() || {}) as Record<string, unknown>
      );
      body = {
        message: "Browser location resolved",
        data: {
          location:
            "10 Downing Street, Westminster, London, England, SW1A 2AA, United Kingdom",
          countryCode: "GB",
          currency: "GBP",
          source: "openstreetmap",
          attribution: "© OpenStreetMap contributors",
          attributionUrl: "https://www.openstreetmap.org/copyright",
        },
      };
    } else if (path.endsWith("/api/user/me")) {
      body = {
        _id: "e2e-user",
        email: "alex.morgan@example.com",
        username: "Alex Morgan",
        isReportApprover: approver,
        isReleaseManager: releaseManager,
        proposalValuationEnabled: true,
      };
    } else if (path.endsWith("/api/reports/stats")) {
      body = {
        totalReports: 12,
        totalFairMarketValue: 1_240_000,
        breakdown: {
          counts: { "Market comparison": 7, "Cost approach": 5 },
          values: {
            "Market comparison": 840_000,
            "Cost approach": 400_000,
          },
        },
      };
    } else if (path.endsWith("/api/reports/myreports")) {
      body = [];
    } else if (path.endsWith("/api/asset/proposal-valuations")) {
      body = {
        items: [
          {
            reportId: "e2e-pv",
            title: "E2E collaborative valuation",
            contractNo: "PV-E2E-100",
            status: "approved",
            role: "owner",
            updatedAt: "2026-08-30T12:00:00.000Z",
            revision: 7,
            participantCount: 1,
            currencyCode: "CAD",
          },
        ],
      };
    } else if (path.endsWith("/api/asset/e2e-pv/proposal-valuation")) {
      body = {
        reportId: "e2e-pv",
        title: "E2E collaborative valuation",
        variant: "assetScheduleSheet",
        currencyCode: "CAD",
        revision: 7,
        permissions: {
          canManageEvaluators: true,
          canEditAll: true,
          evaluatorColumnId: null,
          canRegenerateFiles: true,
        },
        participants: [],
        calculationVersion: "asset-pv-v1",
        calculations: [],
        assetScheduleSheet: {
          evaluator_columns: [
            {
              id: "femi-column",
              name: "Femi John",
              user_id: "e2e-user",
              email: "alex.morgan@example.com",
            },
          ],
          rows: [
            {
              lot_id: "lot-13",
              asset_id: "13",
              asset_category: "Light Duty Pickup Truck",
              year: "2023",
              make: "Ford",
              model: "F-150",
              serial_number: "E2E-SERIAL-13",
              cr_details: "SuperCrew pickup with 4WD",
              condition_score: "4",
              location: "Regina, SK",
              pictures: 0,
              picture_urls: [],
              market_check: {
                comparable_count: "Moderate",
                avg_retail_asking_price: "Moderate",
                market_saturation: "Low",
                market_velocity: "Normal",
                regional_demand: "Strong",
                notes: "",
              },
              asset_insight: "CA$42,000",
              evaluator_values: { "femi-column": 42000 },
              low_est_sale_value: 42000,
              high_est_sale_value: 42000,
              buyer_premium_percent: 15,
              buyer_premium_amount: 2000,
              total_expected_gross: 44000,
              allocated_value: 44000,
              notes: "",
              cleaning: 420,
              lien_search: 50,
              video_cost: 100,
              lotting_fee: 420,
              advertising: 420,
            },
          ],
          file_summary: {
            buyers_premium_basis: "uncapped",
            total_risk_weighted_value: 38000,
            file_risk_multiplier: 0.9,
            commission_percent_no_guarantee: 12,
            offer2_nmg_percent: 0.785,
            capped_threshold_percent: 0.1,
          },
        },
      };
    } else if (path.endsWith("/api/asset/category-specs")) {
      body = {
        message: "ok",
        data: { categories: [], specs: [] },
      };
    } else if (path.endsWith("/api/asset/e2e-asset-preview/preview")) {
      const coverImages = Array.from(
        { length: 5 },
        (_, index) => `${reportThumbnailUrl}#cover-${index + 1}`
      );
      const previewData = {
        client_name: "E2E Asset Preview",
        location: "Leeds Equipment Yard, United Kingdom",
        currency: "GBP",
        grouping_mode: "per_item",
        valuation_methods: [],
        valuation_data: { methods: [] },
        lots: Array.from({ length: 45 }, (_, index) => ({
          lot_id: `e2e-lot-${index + 1}`,
          lot_number: String(index + 1),
          title: `E2E Asset ${index + 1}`,
          categories: "Construction Equipment",
          description: "Responsive preview test asset",
          details: "Maintained field equipment",
          estimated_value: "GBP 1,000",
          mixed_group_index: 1,
          sub_mode: "per_item",
          image_indexes: [index % coverImages.length],
          image_urls: [coverImages[index % coverImages.length]],
          condition_report_specs: {},
        })),
      };
      body =
        request.method() === "PUT"
          ? {
              message: "Saved",
              data: request.postDataJSON()?.preview_data || previewData,
              imageUrls: coverImages,
              image_count: coverImages.length,
            }
          : {
              data: {
                status: "preview",
                grouping_mode: "per_item",
                image_count: coverImages.length,
                imageUrls: coverImages,
                preview_data: previewData,
              },
            };
    } else if (path.endsWith("/api/asset")) {
      body = {
        message: "ok",
        data: [
          {
            _id: "e2e-asset-report",
            user: "e2e-user",
            grouping_mode: "lot",
            imageUrls: [],
            status: "approved",
            lots: [
              {
                lot_number: "12",
                estimated_value: "48000",
                image_urls: [reportThumbnailUrl],
              },
            ],
            client_name: "Northfield Plant Ltd",
            contract_no: "CV-E2E-REPORT",
            preview_files: {
              pdf: "/files/cv-e2e-report.pdf",
            },
            createdAt: "2026-08-02T09:00:00.000Z",
            updatedAt: "2026-08-02T09:30:00.000Z",
          },
          {
            _id: "e2e-asset-preview",
            user: "e2e-user",
            grouping_mode: "lot",
            imageUrls: [],
            status: "processing",
            workflow_stage: "preview_ready",
            generation_state: "queued",
            job_status: "processing",
            files_generating: false,
            lots: [{ lot_number: "21" }],
            client_name: "E2E Asset Preview",
            contract_no: "CV-E2E-ASSET-PREVIEW",
            createdAt: "2026-08-03T08:00:00.000Z",
            updatedAt: "2026-08-03T08:30:00.000Z",
          },
        ],
      };
    } else if (path.endsWith("/api/real-estate")) {
      body = { data: [] };
    } else if (path.endsWith("/api/lot-listing")) {
      body = {
        data: [
          {
            _id: "e2e-lot-preview",
            user: "e2e-user",
            status: "processing",
            workflow_stage: "preview_ready",
            generation_state: "processing",
            job_status: "queued",
            files_generating: false,
            details: {
              contract_no: "CV-E2E-LOT-PREVIEW",
              currency: "GBP",
            },
            lots: [
              {
                lot_id: "e2e-lot-1",
                lot_number: "1",
                image_indexes: [],
              },
            ],
            imageUrls: [],
            createdAt: "2026-08-03T09:00:00.000Z",
            updatedAt: "2026-08-03T09:30:00.000Z",
          },
        ],
      };
    } else if (path.endsWith("/api/auctioneer/status")) {
      body = {
        enabled: true,
        configured: true,
        reachable: true,
      };
    } else if (path.endsWith("/api/auctioneer/incoming/summary")) {
      body = {
        availableCount: incomingItems.filter(
          (item) => item.status === "available"
        ).length,
      };
    } else if (path.endsWith("/api/auctioneer/incoming")) {
      onIncomingRequest?.(url);
      body = { data: { items: incomingItems } };
    } else if (
      path.includes("/api/auctioneer/incoming/") &&
      path.endsWith("/claim")
    ) {
      body = {
        data: {
          workItemId: "e2e-work-item-100",
          cycleKey: incomingItem.cycleKey,
          kind: incomingItem.kind,
          reportType: "asset",
          contract: {
            id: incomingItem.contractId,
            contractNo: incomingItem.contractNo,
            customerName: incomingItem.customerName,
            eventId: incomingItem.eventId,
            eventTitle: incomingItem.eventTitle,
            eventDate: incomingItem.eventDate,
            location: incomingItem.location,
          },
          lots: [],
        },
      };
    } else {
      body = { data: [] };
    }

    await route.fulfill({
      status: 200,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  });
}

async function mockSmartUploadApi(page: Page, onComplete: () => void) {
  type ManifestFile = {
    fileId: string;
    name: string;
    type: string;
    size: number;
    originalOrder: number;
  };

  let manifest: ManifestFile[] = [];
  const grouping = () => {
    const files = manifest.map((file) => ({
      fileId: file.fileId,
      name: file.name,
      mimeType: file.type,
      size: file.size,
      originalOrder: file.originalOrder,
      url: reportThumbnailUrl,
    }));
    return {
      sessionId: "smart-e2e-session",
      smartUpload: true,
      groupingStatus: "review_ready",
      progressPercent: 100,
      revision: 0,
      orderReviewRequired: false,
      unresolvedDividerIds: [],
      hasOrderReviewState: true,
      groups: Array.from(
        { length: Math.ceil(files.length / 3) },
        (_, groupIndex) => {
          const groupFiles = files.slice(groupIndex * 3, groupIndex * 3 + 3);
          return {
            groupIndex,
            imageCount: groupFiles.length,
            fileIds: groupFiles.map((file) => file.fileId),
            files: groupFiles,
            overLimit: false,
          };
        }
      ),
      dividerFileIds: [],
      metrics: [],
      warnings: [],
      expectedFileCount: files.length,
      confirmedFileCount: files.length,
      files,
    };
  };

  await page.route("https://r2.e2e.test/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "PUT, OPTIONS",
        "access-control-allow-origin": "*",
      },
      body: "",
    });
  });

  await page.route("**/api/asset/upload-session**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let body: unknown;

    if (path.endsWith("/api/asset/upload-session") && method === "POST") {
      const requestBody = request.postDataJSON() as { files?: ManifestFile[] };
      manifest = requestBody.files || [];
      body = {
        data: {
          sessionId: "smart-e2e-session",
          jobId: "smart-e2e-job",
          files: manifest.map((file) => ({
            fileId: file.fileId,
            uploadUrl: `https://r2.e2e.test/${file.fileId}`,
            method: "PUT",
            contentType: file.type,
          })),
          nextCursor: null,
        },
      };
    } else if (path.endsWith("/confirm-files") && method === "POST") {
      body = { data: { confirmed: true } };
    } else if (path.endsWith("/detect-dividers") && method === "POST") {
      body = { data: grouping() };
    } else if (path.endsWith("/smart-grouping") && method === "GET") {
      body = { data: grouping() };
    } else if (path.endsWith("/smart-grouping") && method === "PATCH") {
      body = { data: { ...grouping(), groupingStatus: "confirmed" } };
    } else if (path.endsWith("/complete") && method === "POST") {
      onComplete();
      body = {
        message: "Smart Upload accepted",
        reportId: "smart-e2e-report",
        jobId: "smart-e2e-job",
        status: "processing",
        phase: "processing",
      };
    } else {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  });
}

for (const kind of ['asset', 'lot-listing'] as const) {
  test(`Schedule A split controls for ${kind}`, async ({ page }) => {
    await mockAuthenticatedApi(page);
    const setup = { workItemId: "split-work", cycleKey: "split-cycle", clientSubmissionId: "split-submission",
      status: "claimed", reportType: kind === "asset" ? "asset" : "lotListing", kind: "scheduleA",
      contract: { id: "split-contract", contractNo: "SPLIT-100", customerName: "Split client" },
      lots: [{ sourceKey: "parent-line", lotId: "upstream-parent", lotNumber: "100", description: "Original line" }],
    };
    await page.addInitScript(({ kind, setup }) => {
      sessionStorage.setItem("cv:report-form-handoff:v1", JSON.stringify({ version: 1, kind, auctioneer: setup }));
    }, { kind, setup });
    await page.goto(`/create/${kind}`);
    await page.getByRole("button", { name: "Add lot to this line", exact: true }).click();
    await expect(page.getByRole("radio", { name: /Bundle/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /Bundle/ })).toBeDisabled();
    await expect(page.getByLabel("Add main photos", { exact: true })).toBeAttached();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `/tmp/split-${kind}-${page.viewportSize()?.width}.png` });
  });

  test(`Continue opens prefilled fresh ${kind} while report is processing`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await mockAuthenticatedApi(page);
    const contract = { id: 'continue-contract', contractNo: 'CONTINUE-100', customerName: 'Continuation client', eventDate: '2026-10-05', location: 'Original yard' };
    const setup = { workItemId: 'parent-work', cycleKey: 'parent-cycle', clientSubmissionId: 'parent-submission', status: 'claimed', reportType: kind === 'asset' ? 'asset' : 'lotListing', kind: 'unknown', contract, lots: [] };
    await page.addInitScript(({ kind, setup }) => {
      sessionStorage.setItem('cv:report-form-handoff:v1', JSON.stringify({ version: 1, kind, auctioneer: setup }));
    }, { kind, setup });
    let submissions = 0;
    await page.route('**/api/**/upload-session**', async route => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown;
      if (path.endsWith('/upload-session')) {
        const files = route.request().postDataJSON().files;
        data = { data: { sessionId: 'continue-session', jobId: 'continue-job', files: files.map((file: { fileId: string; type: string }) => ({ fileId: file.fileId, uploadUrl: `https://r2.e2e.test/${file.fileId}`, method: 'PUT', contentType: file.type })), nextCursor: null } };
      } else if (path.endsWith('/complete')) {
        submissions++;
        data = { reportId: 'accepted-report', jobId: 'continue-job', status: 'processing' };
      } else data = { data: { confirmed: true } };
      await route.fulfill({ json: data });
    });
    await page.route('https://r2.e2e.test/**', route => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'PUT, OPTIONS' }, body: '' }));
    await page.route('**/api/auctioneer/work-items/parent-work/continue', route => route.fulfill({ json: { data: { ...setup, workItemId: 'child-work', cycleKey: 'child-cycle', clientSubmissionId: 'child-submission' } } }));
    await page.goto(`/create/${kind}`);
    await page.getByLabel(/inspection location/i).fill('Edited continuation yard');
    await page.getByLabel(/^Currency/).fill('USD');
    await page.getByRole('radiogroup').getByText('Bundle', { exact: true }).click();
    await expect(page.getByRole('radio', { name: /Bundle/ })).toBeChecked();
    await page.getByLabel('Add main photos', { exact: true }).setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfU0AAAAASUVORK5CYII=', 'base64') });
    await page.getByRole('button', { name: 'Create Lot & Continue', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Fresh lot for contract CONTINUE-100' })).toBeVisible();
    await expect(page.getByLabel(/inspection location/i)).toHaveValue('Edited continuation yard');
    await expect(page.getByLabel(/^Currency/)).toHaveValue('USD');
    await expect(page.getByText('0 main', { exact: true })).toBeVisible();
    expect(submissions).toBe(1);
    expect(pageErrors).toEqual([]);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousAccessibilityViolations(page);
    await page.screenshot({ path: `/tmp/continue-${kind}-${page.viewportSize()?.width}.png` });
  });
}

async function expectTheme(page: Page, theme: ThemeMode) {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect
    .poll(() =>
      page.locator("html").evaluate((element) => element.style.colorScheme)
    )
    .toBe(theme);
}

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    rootScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  const widestDocumentWidth = Math.max(
    metrics.rootScrollWidth,
    metrics.bodyScrollWidth
  );

  expect(
    widestDocumentWidth,
    `Document width ${widestDocumentWidth}px exceeded the ${metrics.viewportWidth}px viewport`
  ).toBeLessThanOrEqual(metrics.viewportWidth + 1);
}

async function expectElementContained(
  element: Locator,
  {
    label,
    requireVerticalFit,
  }: {
    label: string;
    requireVerticalFit: boolean;
  }
) {
  const metrics = await element.evaluate((node) => {
    const target = node as HTMLElement;
    const style = window.getComputedStyle(target);
    return {
      clientHeight: target.clientHeight,
      clientWidth: target.clientWidth,
      offsetWidth: target.offsetWidth,
      scrollHeight: target.scrollHeight,
      scrollWidth: target.scrollWidth,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      scrollbarWidth: Math.max(0, target.offsetWidth - target.clientWidth),
    };
  });

  expect(
    metrics.scrollWidth,
    `${label} overflowed horizontally: ${JSON.stringify(metrics)}`
  ).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(
    metrics.scrollbarWidth,
    `${label} exposed a visible scrollbar gutter: ${JSON.stringify(metrics)}`
  ).toBeLessThanOrEqual(2);
  if (requireVerticalFit) {
    expect(
      metrics.scrollHeight,
      `${label} required vertical scrolling at a supported desktop height: ${JSON.stringify(metrics)}`
    ).toBeLessThanOrEqual(metrics.clientHeight + 1);
  } else {
    expect(["auto", "scroll"]).toContain(metrics.overflowY);
  }
}

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const violations = results.violations.filter(
    (violation) =>
      violation.impact === "critical" || violation.impact === "serious"
  );

  expect(
    violations,
    violations
      .map(
        (violation) =>
          `${violation.id}: ${violation.description} (${violation.nodes.length} nodes)`
      )
      .join("\n")
  ).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test(`Reports completed deep link in ${theme} mode`, async ({ page }) => {
    await initializeTheme(page, theme);
    await mockAuthenticatedApi(page);
    await page.route("**/api/auctioneer/deliveries**", route => route.fulfill({ json: { data: [{
      workItemId: "sent-work", reportId: "e2e-asset-report", reportModel: "AssetReport",
      reportType: "asset", contractNo: "CV-E2E-REPORT", state: "sent", canSend: false,
    }] } }));
    await page.goto("/reports?search=CV-E2E-REPORT");
    const tab = page.getByRole("tab", { name: "Completed 1" });
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("img", { name: /Preview image for Asset.*CV-E2E-REPORT/i }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousAccessibilityViolations(page);
  });
  test(`public landing and sign-in are keyboard accessible in ${theme} mode`, async ({
    page,
  }) => {
    await initializeTheme(page, theme);
    await page.goto("/");

    await expect(
      page.getByRole("heading", {
        level: 1,
        name: /Client-ready valuation packages/i,
      })
    ).toBeVisible();
    await expectTheme(page, theme);
    await expect(
      page.getByRole("img", { name: /Asset appraiser reviewing/i })
    ).toBeVisible();

    const signIn = page.getByRole("link", { name: "Sign in" }).first();
    await signIn.focus();
    await expect(signIn).toBeFocused();
    await Promise.all([
      page.waitForURL(/\/login$/, { waitUntil: "domcontentloaded" }),
      signIn.press("Enter"),
    ]);

    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("heading", { level: 2, name: "Welcome back" })
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expectTheme(page, theme);
    await expectNoSeriousAccessibilityViolations(page);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`Incoming contact roles in ${theme} mode`, async ({ page }, testInfo) => {
    if (testInfo.project.name === "mobile") {
      await page.setViewportSize({ width: 320, height: 844 });
    }
    const consignorName = "Northern Prairie Equipment Holdings Ltd";
    const salespersonName = "Morgan Sinclair";
    await initializeTheme(page, theme);
    await mockAuthenticatedApi(page, { incomingItems: [
      { ...incomingItem, consignorName, salespersonName },
      { ...incomingItem, cycleKey: "missing-contacts", contractNo: "NO-CONTACTS" },
    ] });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) errors.push(message.text());
    });
    await page.goto("/incoming");
    await expect(page).toHaveURL(/\/incoming$/);
    await expect(page).toHaveTitle(/Asset Insight/);
    await expect(page.getByRole("heading", { level: 1, name: "Incoming" })).toBeVisible();
    const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Review CV-E2E-100" }) });
    await expect(row.locator('[data-label="Consignor"]')).toHaveText(consignorName);
    await expect(row.locator('[data-label="Salesperson"]')).toHaveText(salespersonName);
    await expect(row.locator('[data-label="Customer"]')).toHaveText(incomingItem.customerName);
    const missing = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Review NO-CONTACTS" }) });
    await expect(missing.locator('[data-label="Consignor"]')).toHaveText("Not supplied");
    await expect(missing.locator('[data-label="Salesperson"]')).toHaveText("Not supplied");
    await expectNoHorizontalOverflow(page);
    const tableWidths = await page.locator(".app-table-wrap").evaluate((element) => ({
      available: element.clientWidth,
      content: element.scrollWidth,
    }));
    expect(tableWidths.content, "Contact columns should fit the queue at supported widths")
      .toBeLessThanOrEqual(tableWidths.available + 1);
    await page.screenshot({ path: `/tmp/incoming-contacts-${testInfo.project.name}-${theme}-table.png` });

    const review = row.getByRole("button", { name: "Review CV-E2E-100" });
    await review.focus();
    await expect(review).toBeFocused();
    await review.press("Enter");
    const details = page.getByRole("complementary", { name: "Selected contract" });
    await expect(details).toHaveAttribute("data-open", "true");
    await expect(details.getByText(consignorName, { exact: true })).toBeVisible();
    await expect(details.getByText(salespersonName, { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousAccessibilityViolations(page);
    await expect(page.locator("nextjs-portal [data-nextjs-dialog-overlay]")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `/tmp/incoming-contacts-${testInfo.project.name}-${theme}-details.png` });
  });
  test(`Incoming completed queue in ${theme} mode`, async ({ page }, testInfo) => {
    await initializeTheme(page, theme);
    await mockAuthenticatedApi(page, { incomingItems: [incomingItem,
      { ...incomingItem, cycleKey: 'sent-cycle', contractNo: 'SENT-200', status: 'sent' },
      { ...incomingItem, cycleKey: 'abandoned-cycle', contractNo: 'REVIEW-300', status: 'abandoned' },
    ] });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/incoming');
    await expect(page.getByRole('tab', { name: 'Outstanding 2' })).toBeVisible();
    await expect(page.getByText('REVIEW-300', { exact: true })).toBeVisible();
    await expect(page.getByText('SENT-200', { exact: true })).toHaveCount(0);
    const completed = page.getByRole('tab', { name: 'Completed 1' });
    await completed.focus();
    await completed.press('Enter');
    await expect(completed).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('SENT-200', { exact: true })).toBeVisible();
    await expect(page.getByText('REVIEW-300', { exact: true })).toHaveCount(0);
    await expectNoSeriousAccessibilityViolations(page);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `/tmp/assetinsight-incoming-${testInfo.project.name}-${theme}.png` });
  });
  test(`authenticated dashboard and Incoming smoke in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    const isMobile = Boolean(testInfo.project.use.isMobile);
    await initializeTheme(page, theme);
    await mockAuthenticatedApi(page);
    await page.goto("/dashboard");

    await expect(
      page.getByRole("heading", { level: 1, name: /Alex Morgan/ })
    ).toBeVisible();
    await expectTheme(page, theme);

    if (isMobile) {
      await page.getByRole("button", { name: "Open navigation" }).click();
    }

    const incoming = page.getByRole("link", { name: /Incoming/ });
    await expect(incoming).toBeVisible();
    await incoming.focus();
    await expect(incoming).toBeFocused();
    await incoming.press("Enter");

    await expect(page).toHaveURL(/\/incoming$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Incoming" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Review CV-E2E-100" })
    ).toBeVisible();

    const themeButtonName = isMobile
      ? theme === "dark"
        ? "Use light theme"
        : "Use dark theme"
      : theme === "dark"
        ? "Light theme"
        : "Dark theme";
    if (isMobile) {
      await page
        .getByRole("button", { name: themeButtonName, exact: true })
        .click();
    } else {
      await page
        .getByRole("button", { name: themeButtonName, exact: true })
        .click();
    }
    const opposite = theme === "dark" ? "light" : "dark";
    await expectTheme(page, opposite);
    await page.reload();
    await expectTheme(page, opposite);
    await expect(
      page.getByRole("heading", { level: 1, name: "Incoming" })
    ).toBeVisible();
    await expectNoSeriousAccessibilityViolations(page);
  });
}

test("Incoming remains visible for a standard authenticated user", async ({
  page,
}, testInfo) => {
  const isMobile = Boolean(testInfo.project.use.isMobile);
  await initializeTheme(page, "light");
  await mockAuthenticatedApi(page, {
    approver: false,
    releaseManager: false,
  });
  await page.goto("/dashboard");

  if (isMobile) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }

  await expect(page.getByRole("link", { name: /Incoming/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Approvals" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Releases" })).toHaveCount(0);
});

test("Smart Upload keeps a large review bounded and completes from the report workspace", async ({
  page,
}) => {
  test.setTimeout(60_000);
  let completedReports = 0;
  await initializeTheme(page, "light");
  await mockAuthenticatedApi(page);
  await mockSmartUploadApi(page, () => {
    completedReports += 1;
  });
  await page.goto("/dashboard");

  await page.getByRole("button", { name: "Create report", exact: true }).click();
  await expect(page).toHaveURL(/\/create\/asset$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Asset Report" })
  ).toBeVisible();
  await page.getByLabel("Client name").fill("Smart Upload QA");
  await page.getByLabel("Appraisal purpose").fill("Insurance valuation");
  await page.getByLabel("Currency").fill("CAD");
  await page
    .getByLabel(/^Inspection location/)
    .fill("Smart Upload QA Yard, Leeds");
  await page.getByRole("button", { name: "Smart Upload", exact: true }).click();

  const workspace = page.getByRole("dialog", { name: "Smart Upload" });
  await expect(workspace).toBeVisible();
  const fileInput = workspace.locator('input[type="file"][multiple]');
  await fileInput.setInputFiles(
    Array.from({ length: 24 }, (_, index) => ({
      name: `photo-${String(index + 1).padStart(2, "0")}.jpg`,
      mimeType: "image/jpeg",
      buffer: Buffer.from(`e2e-photo-${index + 1}`),
    }))
  );

  await expect(workspace.getByText("24 images -", { exact: false })).toBeVisible();
  await workspace
    .getByRole("button", { name: "Upload & detect lots" })
    .click();

  await expect(workspace.getByText("Images 1-12 of 24")).toBeVisible({
    timeout: 20_000,
  });
  await expect(workspace.getByText("Lots 1-6 of 8")).toBeVisible();
  // The bounded review renders one 12-image sequence page, six lot covers,
  // and the selected three-photo lot; later pages replace rather than append.
  const expectedVisibleReviewImages = 21;
  await expect(workspace.locator("img")).toHaveCount(
    expectedVisibleReviewImages
  );
  await expect(workspace.locator('img[loading="lazy"][decoding="async"]')).toHaveCount(
    expectedVisibleReviewImages
  );
  await expect(page).toHaveURL(/\/create\/asset$/);

  await workspace.getByRole("button", { name: "Next images" }).click();
  await expect(workspace.getByText("Images 13-24 of 24")).toBeVisible();
  await expect(workspace.locator("img")).toHaveCount(
    expectedVisibleReviewImages
  );

  await workspace.getByRole("button", { name: "Create preview" }).click();
  await expect(workspace).toHaveCount(0);
  await expect
    .poll(() => completedReports)
    .toBe(1);
  await expect(page).toHaveURL(/\/previews$/);
  await expect(
    page.getByText(
      "Smart Upload accepted - preview processing continues in My Reports.",
      { exact: true }
    )
  ).toBeVisible();
});

test("Asset and Lot Listing resolve synthetic browser coordinates to a readable place", async ({
  context,
  page,
}, testInfo) => {
  test.skip(!["desktop", "mobile"].includes(testInfo.project.name));
  const requestedCoordinates: Array<Record<string, unknown>> = [];
  await context.grantPermissions(["geolocation"], { origin: baseURL });
  await context.setGeolocation({
    latitude: 51.503407,
    longitude: -0.127592,
    accuracy: 8,
  });
  await initializeTheme(page, "light");
  await mockAuthenticatedApi(page, {
    onLocationRequest: (body) => requestedCoordinates.push(body),
  });

  for (const form of [
    {
      path: "/create/asset",
      heading: "Asset Report",
      label: /Inspection location/i,
    },
    {
      path: "/create/lot-listing",
      heading: "Lot Listing",
      label: /Current inspection location/i,
    },
  ]) {
    await page.goto(form.path);
    await expect(
      page.getByRole("heading", { level: 1, name: form.heading })
    ).toBeVisible();
    const location = page.getByLabel(form.label);
    await expect(location).toHaveValue(
      "10 Downing Street, Westminster, London, England, SW1A 2AA, United Kingdom"
    );
    await expect(
      page.getByRole("link", { name: "© OpenStreetMap contributors" })
    ).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
    await expect(
      page.getByRole("textbox", { name: /latitude|longitude/i })
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  }

  expect(requestedCoordinates.length).toBeGreaterThanOrEqual(2);
  for (const requestBody of requestedCoordinates) {
    expect(requestBody).toEqual({
      latitude: 51.503407,
      longitude: -0.127592,
    });
  }
});

test("Incoming keeps user assignment server-side and explains an empty queue", async ({
  page,
}) => {
  const incomingRequestUrls: URL[] = [];

  await initializeTheme(page, "light");
  await mockAuthenticatedApi(page, {
    incomingItems: [],
    onIncomingRequest: (url) => incomingRequestUrls.push(url),
  });
  await page.goto("/incoming");

  await expect(
    page.getByRole("heading", { name: "No assigned lots" })
  ).toBeVisible();
  await expect(
    page.getByText(
      "No Auctioneer lots are currently assigned to your account."
    )
  ).toBeVisible();
  await expect
    .poll(() => incomingRequestUrls.length)
    .toBeGreaterThan(0);
  expect(
    incomingRequestUrls.every((url) => !url.searchParams.has("userId"))
  ).toBe(true);
});

test("enterprise shell landmarks and My Reports stay responsive", async ({
  page,
}, testInfo) => {
  const isMobile = Boolean(testInfo.project.use.isMobile);
  await initializeTheme(page, "light");
  await mockAuthenticatedApi(page);
  await page.goto("/dashboard");

  if (isMobile) {
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("complementary", {
      name: "Primary navigation",
    });
    await expect(drawer).toBeVisible();
    const drawerNavigation = drawer
      .getByText("Workspace", { exact: true })
      .locator("xpath=../..");
    await expectElementContained(drawerNavigation, {
      label: "Mobile navigation drawer",
      requireVerticalFit: false,
    });
    await expectNoHorizontalOverflow(page);
  } else {
    const sidebar = page.getByRole("complementary", {
      name: "Primary navigation",
    });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByText("Workspace", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Review", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Account", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Toggle navigation width" })
    ).toBeVisible();
    await expect(
      page.getByRole("searchbox", {
        name: "Search reports, lots, and clients",
      })
    ).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: "Light theme" })
    ).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: "Dark theme" })
    ).toBeVisible();
  }

  const expectedDestinations = ["Dashboard", "Incoming", "My Reports", "Previews"];
  for (const label of expectedDestinations) {
    await expect(
      page.getByRole("link", { name: new RegExp(label) })
    ).toBeVisible();
  }

  await page.getByRole("link", { name: "My Reports" }).press("Enter");
  await expect(page).toHaveURL(/\/reports$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "My reports" })
  ).toBeVisible();

  const thumbnail = page.getByRole("img", {
    name: /Preview image for Asset.*CV-E2E-REPORT/i,
  });
  if ((await thumbnail.count()) === 0) {
    const deferredMobileCard = page
      .locator("main li")
      .filter({ hasText: "Asset · CV-E2E-REPORT" });
    await expect(deferredMobileCard).toHaveCount(1);
    await deferredMobileCard.scrollIntoViewIfNeeded();
  }
  await thumbnail.scrollIntoViewIfNeeded();
  await expect(thumbnail).toBeVisible();
  await expect(thumbnail).toHaveAttribute("loading", "lazy");
  await expect(thumbnail).toHaveAttribute("decoding", "async");
  await expect(thumbnail).toHaveAttribute("fetchpriority", "low");
  await expectNoHorizontalOverflow(page);
});

test("desktop sidebar fits without a visible scrollbar at 1024x768", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.setViewportSize({ width: 1024, height: 768 });
  await initializeTheme(page, "light");
  await mockAuthenticatedApi(page);
  await page.goto("/dashboard");

  const sidebar = page.getByRole("complementary", {
    name: "Primary navigation",
  });
  await expect(sidebar).toBeVisible();
  const navigation = sidebar
    .getByText("Workspace", { exact: true })
    .locator("xpath=../..");
  await expectElementContained(navigation, {
    label: "Desktop sidebar navigation",
    requireVerticalFit: true,
  });

  const themeGroup = sidebar.getByRole("group", { name: "Color theme" });
  await expect(themeGroup).toBeVisible();
  await expect(
    themeGroup.getByRole("button", { name: "Light theme" })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    themeGroup.getByRole("button", { name: "Dark theme" })
  ).toHaveAttribute("aria-pressed", "false");
  await expectNoHorizontalOverflow(page);
});

test("mobile preview actions remain visible without page overflow", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await initializeTheme(page, "light");
  await mockAuthenticatedApi(page);
  await page.goto("/previews");

  await expect(
    page.getByRole("button", {
      name: "Preview Asset report: E2E Asset Preview",
    })
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Preview Lot Listing report: CV-E2E-LOT-PREVIEW",
    })
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("asset preview cover and bulk required selections stay responsive in both themes", async ({
  page,
}, testInfo) => {
  test.skip(!["desktop", "mobile"].includes(testInfo.project.name));
  const theme: ThemeMode = testInfo.project.name === "mobile" ? "dark" : "light";
  await initializeTheme(page, theme);
  await mockAuthenticatedApi(page);
  await page.goto("/previews");

  await page
    .getByRole("button", {
      name: "Preview Asset report: E2E Asset Preview",
    })
    .click();

  const preview = page.getByRole("dialog", { name: "Preview & Edit Report" });
  await expect(preview).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(
    preview.getByRole("region", { name: "Appraiser document cover images" })
  ).toBeVisible();

  await preview.getByRole("button", { name: "Select cover images" }).click();
  const picker = page.getByRole("dialog", { name: "Select cover images" });
  await expect(picker.getByRole("img", { name: /Report image/ })).toHaveCount(5);
  await picker.getByRole("button", { name: "Select cover image 2" }).click();
  await picker.getByRole("button", { name: "Select cover image 1" }).click();
  await picker.getByRole("button", { name: "Apply cover images" }).click();
  await expect(preview.getByText("2 of 4 cover images selected.")).toBeVisible();

  for (const lotNumber of [4, 8, 9]) {
    await preview
      .getByRole("checkbox", {
        name: `Select lot ${lotNumber}, row ${lotNumber}`,
      })
      .click();
  }
  await expect(
    preview.getByText(
      "3 of 45 lots selected. Apply a value below or adjust any lot individually."
    )
  ).toBeVisible();

  const bulkLegal = preview.getByRole("group", {
    name: "Apply Legal value to selected lots",
  });
  await bulkLegal
    .getByRole("button", { name: "Apply N/A to 3 selected lots" })
    .click();
  await expect(
    bulkLegal.getByRole("button", { name: "Apply N/A to 3 selected lots" })
  ).toHaveAttribute("aria-pressed", "true");

  const selectionControl = preview.getByRole("group", {
    name: "Select lots for bulk required selections",
  });
  await selectionControl
    .getByRole("button", { name: "Select all 45 lots" })
    .click();
  await expect(
    preview.getByText(
      "45 of 45 lots selected. Apply a value below or adjust any lot individually."
    )
  ).toBeVisible();
  await bulkLegal
    .getByRole("button", { name: "Apply No Title to 45 selected lots" })
    .click();
  await expect(
    bulkLegal.getByRole("button", {
      name: "Apply No Title to 45 selected lots",
    })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    selectionControl.getByRole("button", { name: "Unselect all 45 lots" })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    preview.getByRole("checkbox", { name: "Select lot 4, row 4" })
  ).toBeChecked();
  await expect(
    preview.getByRole("checkbox", { name: "Select lot 8, row 8" })
  ).toBeChecked();
  await expect(
    preview.getByRole("checkbox", { name: "Select lot 9, row 9" })
  ).toBeChecked();
  await expect(
    preview.getByRole("navigation", { name: "Asset lots pagination", exact: true }).getByText("Showing 1–20 of 45 lots")
  ).toBeVisible();
  await preview.getByRole("navigation", { name: "Asset lots pagination", exact: true }).getByRole("button", { name: "Next lots page" }).click();
  await expect(
    preview.getByRole("navigation", { name: "Asset lots pagination", exact: true }).getByText("Showing 21–40 of 45 lots")
  ).toBeVisible();
  await expect(
    preview.getByRole("checkbox", { name: "Select lot 21, row 21" })
  ).toBeChecked();
  await expect(
    bulkLegal.getByRole("button", {
      name: "Apply No Title to 45 selected lots",
    })
  ).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expectNoHorizontalOverflow(page);
});

for (const theme of ["light", "dark"] as const) {
  test(`asset preview bulk selections persist selected and all 100 lots in ${theme} theme`, async ({ page }, testInfo) => {
    test.skip(!["desktop", "mobile"].includes(testInfo.project.name));
    test.setTimeout(90_000);
    if (testInfo.project.name === "mobile" && theme === "light") {
      await page.setViewportSize({ width: 320, height: 720 });
    }
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await initializeTheme(page, theme);
    await mockAuthenticatedApi(page);
    const originalLots = Array.from({ length: 100 }, (_, index) => ({
      lot_id: `bulk-lot-${index + 1}`,
      lot_number: String(index + 1),
      title: `Bulk test asset ${index + 1}`,
      description: `Original description for lot ${index + 1}\nSecond line retained.`,
      categories: "Construction Equipment",
      estimated_value: "GBP 1,000",
      sub_mode: "per_item",
      mixed_group_index: 1,
      image_indexes: [0],
      image_urls: [reportThumbnailUrl],
      condition_report_specs: { "Inspector note": `Keep note ${index + 1}` },
      condition_report_selections: { condition: "N/A", completeness: "Incomplete Unit", legal: "No Title" },
    }));
    let savedPreview = {
      client_name: "E2E Asset Preview", location: "Leeds Equipment Yard, United Kingdom",
      currency: "GBP", grouping_mode: "per_item", valuation_methods: [],
      valuation_data: { methods: [] }, lots: structuredClone(originalLots),
    };
    const saves: typeof savedPreview[] = [];
    await page.route("**/api/asset/e2e-asset-preview/preview", async (route) => {
      const request = route.request();
      if (request.method() === "PUT") {
        savedPreview = request.postDataJSON().preview_data;
        saves.push(structuredClone(savedPreview));
      }
      await route.fulfill({
        status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
        body: JSON.stringify(request.method() === "PUT"
          ? { message: "Saved", data: savedPreview, imageUrls: [reportThumbnailUrl], image_count: 1 }
          : { data: { status: "preview", grouping_mode: "per_item", imageUrls: [reportThumbnailUrl], image_count: 1, preview_data: savedPreview } }),
      });
    });
    const openPreview = async () => {
      await page.goto("/previews");
      await expect(page).toHaveURL(/\/previews$/);
      await expect(page).toHaveTitle(/Asset Insight/i);
      await page.getByRole("button", { name: "Preview Asset report: E2E Asset Preview" }).click();
      await expect(page.getByRole("dialog", { name: "Preview & Edit Report" })).toBeVisible();
    };
    await openPreview();
    const preview = page.getByRole("dialog", { name: "Preview & Edit Report" });
    const selection = preview.getByRole("group", { name: "Select lots for bulk required selections" });
    const apply = async (group: string, value: string, count: number) => {
      await preview.getByRole("group", { name: `Apply ${group} value to selected lots` })
        .getByRole("button", { name: `Apply ${value} to ${count} selected lots`, exact: true }).click();
    };
    const field = (group: string, number: number) => preview.getByRole("combobox", {
      name: `${group} for lot ${number}, row ${number}`, exact: true,
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(preview.getByRole("group", { name: "Apply Running Condition value to selected lots" })
      .getByRole("button", { name: "Apply Starts and Runs to 0 selected lots", exact: true })).toBeDisabled();
    for (const number of [4, 8, 9]) {
      await preview.getByRole("checkbox", { name: `Select lot ${number}, row ${number}`, exact: true }).check();
    }
    await apply("Running Condition", "Starts and Runs", 3);
    await apply("Completeness", "Has Keys", 3);
    await apply("Legal", "Salvage", 3);
    await field("Running Condition", 8).selectOption("Does not Start or Run");
    expect(saves).toHaveLength(0);
    await preview.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(() => saves.length).toBe(1);
    for (const [index, lot] of saves[0].lots.entries()) {
      const original = originalLots[index];
      expect(lot).toMatchObject({
        lot_id: original.lot_id, lot_number: original.lot_number,
        title: original.title, description: original.description,
        image_indexes: original.image_indexes, image_urls: original.image_urls,
        condition_report_specs: original.condition_report_specs,
      });
      expect(lot.condition_report_selections).toEqual([3, 7, 8].includes(index)
        ? { condition: index === 7 ? "Does not Start or Run" : "Starts and Runs", completeness: "Has Keys", legal: "Salvage" }
        : original.condition_report_selections);
    }
    await expect(preview.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    await openPreview();
    await expect(field("Running Condition", 8)).toHaveValue("Does not Start or Run");
    await expect(field("Completeness", 4)).toHaveValue("Has Keys");
    await expect(field("Legal", 9)).toHaveValue("Salvage");
    await expect(preview.getByRole("checkbox", { name: "Select lot 4, row 4", exact: true })).not.toBeChecked();
    await selection.getByRole("button", { name: "Select all 100 lots", exact: true }).click();
    await apply("Running Condition", "Starts and Runs with Boost", 100);
    await apply("Completeness", "Missing Parts", 100);
    await apply("Legal", "N/A", 100);
    await field("Legal", 4).selectOption("No Title");
    await preview.getByRole("navigation", { name: "Asset lots pagination", exact: true }).getByRole("button", { name: "Next lots page", exact: true }).click();
    await expect(preview.getByRole("checkbox", { name: "Select lot 21, row 21", exact: true })).toBeChecked();
    await expect(field("Running Condition", 21)).toHaveValue("Starts and Runs with Boost");
    await expect(field("Completeness", 21)).toHaveValue("Missing Parts");
    await expect(field("Legal", 21)).toHaveValue("N/A");
    // Let transient feedback settle before inspecting unobstructed controls.
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await preview.getByRole("region", { name: "Bulk required selections" }).scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    const accessibility = await new AxeBuilder({ page })
      .include('section[aria-label="Bulk required selections"]')
      .analyze();
    expect(accessibility.violations.filter((violation) => ["serious", "critical"].includes(violation.impact || ""))).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`asset-bulk-${testInfo.project.name}-${theme}.png`) });
    await preview.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(() => saves.length).toBe(2);
    for (const [index, lot] of saves[1].lots.entries()) {
      expect(lot.condition_report_selections).toEqual({
        condition: "Starts and Runs with Boost", completeness: "Missing Parts", legal: index === 3 ? "No Title" : "N/A",
      });
      expect(lot.image_urls).toEqual(originalLots[index].image_urls);
      expect(lot.description).toBe(originalLots[index].description);
    }
    await expect(preview.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    await openPreview();
    await expect(field("Running Condition", 1)).toHaveValue("Starts and Runs with Boost");
    await expect(field("Completeness", 1)).toHaveValue("Missing Parts");
    await expect(field("Legal", 4)).toHaveValue("No Title");
    await expect(field("Legal", 1)).toHaveValue("N/A");
    expect(consoleErrors).toEqual([]);
  });
}

test("preview save is single-flight and blocks editing until the write settles", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await initializeTheme(page, "light");
  await mockAuthenticatedApi(page);

  let saveRequests = 0;
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/api/asset/e2e-asset-preview/preview", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    saveRequests += 1;
    const submitted = route.request().postDataJSON()?.preview_data;
    await saveGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: "Saved",
        data: submitted,
      }),
    });
  });

  await page.goto("/previews");
  await page
    .getByRole("button", {
      name: "Preview Asset report: E2E Asset Preview",
    })
    .click();
  const preview = page.getByRole("dialog", { name: "Preview & Edit Report" });
  await preview.getByRole("button", { name: "Select cover images" }).click();
  const picker = page.getByRole("dialog", { name: "Select cover images" });
  await picker.getByRole("button", { name: "Select cover image 1" }).click();
  await picker.getByRole("button", { name: "Apply cover images" }).click();

  const save = preview.getByRole("button", { name: "Save changes" });
  try {
    await save.evaluate((element: HTMLButtonElement) => {
      element.click();
      element.click();
    });
    await expect.poll(() => saveRequests).toBe(1);
    await expect(
      preview.getByText(/Saving preview changes.*Keep this page open/)
    ).toBeVisible();
    await expect(preview.locator("[inert]")).toHaveCount(1);
    await expect(preview.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expectNoHorizontalOverflow(page);
  } finally {
    releaseSave();
  }

  await expect(
    preview.getByText(/Saving preview changes.*Keep this page open/)
  ).toBeHidden();
  await expect.poll(() => saveRequests).toBe(1);
});

test("public and authentication route matrix renders cleanly", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await initializeTheme(page, "light");

  const routes = [
    { path: "/", heading: "Client-ready valuation packages, without the workflow clutter.", level: 1 },
    { path: "/login", heading: "Welcome back", level: 2 },
    { path: "/signup", heading: "Build your workspace", level: 2 },
    { path: "/forgot-password", heading: "Reset your password", level: 2 },
    { path: "/privacy", heading: "Asset Insight privacy notice", level: 1 },
    { path: "/terms/youtube", heading: "YouTube feature terms", level: 1 },
    {
      path: "/verify-email?email=alex%40example.com",
      heading: "Check your inbox",
      level: 2,
    },
    {
      path: "/reset-password/e2e-reset-token",
      heading: "Choose a new password",
      level: 2,
    },
  ] as const;

  for (const route of routes) {
    await page.goto(route.path);
    await expect(
      page.getByRole("heading", {
        level: route.level,
        name: route.heading,
      })
    ).toBeVisible();
    await expectTheme(page, "light");
  }
});

test("authenticated workspace route matrix renders cleanly", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await initializeTheme(page, "light");
  await mockAuthenticatedApi(page);

  const routes = [
    { path: "/dashboard", heading: /Alex Morgan/ },
    { path: "/incoming", heading: "Incoming" },
    { path: "/reports", heading: "My reports" },
    { path: "/proposal-valuations", heading: "Proposal Valuations" },
    { path: "/previews", heading: "Report previews" },
    { path: "/approvals", heading: "Assigned approvals" },
    { path: "/releases", heading: "Assigned releases" },
    { path: "/settings", heading: "Settings" },
  ] as const;

  for (const route of routes) {
    await page.goto(route.path);
    await expect(
      page.getByRole("heading", { level: 1, name: route.heading })
    ).toBeVisible();
    await expectTheme(page, "light");
  }
});

test("Proposal Valuations list offers a responsive Excel export", async ({
  page,
}) => {
  await initializeTheme(page, "light");
  await mockAuthenticatedApi(page);

  await page.goto("/proposal-valuations");
  await expect(
    page.getByRole("heading", { level: 1, name: "Proposal Valuations" })
  ).toBeVisible();
  const exportButton = page.getByRole("button", {
    name: "Export E2E collaborative valuation to Excel",
  });
  await expect(exportButton).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("E2E Proposal Valuation.xlsx");
  await expectTheme(page, "light");
});

test("Proposal Valuation opens as a compact full-page responsive workspace", async ({
  page,
}) => {
  await initializeTheme(page, "light");
  await mockAuthenticatedApi(page);

  await page.goto("/proposal-valuations/e2e-pv");
  await expect(
    page.getByRole("heading", { name: "Proposal Valuation" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close Proposal Valuation" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Export E2E collaborative valuation to Excel",
    })
  ).toBeVisible();
  await expect(page.getByText("1–1 of 1")).toBeVisible();

  await page.getByRole("button", { name: "File summary" }).click();
  await page
    .getByRole("button", { name: "How Total Asset Value is calculated" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Total asset value" })
  ).toBeVisible();
  await expect(page.getByText("Calculation steps")).toBeVisible();
  await expectTheme(page, "light");
});

test("Incoming claim opens the selected full-page report workflow", async ({
  page,
}) => {
  await initializeTheme(page, "light");
  await mockAuthenticatedApi(page);
  await page.goto("/incoming");

  await page
    .getByRole("button", { name: "Review CV-E2E-100" })
    .click();
  await page
    .getByRole("button", { name: "Claim and create report" })
    .click();

  await expect(page).toHaveURL(/\/create\/asset$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Asset Report" })
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Asset Report form" })
  ).toBeVisible();
  await expect(page.getByLabel(/^Client name/)).toHaveValue(
    "Northfield Plant Ltd"
  );
  await expect(page.getByLabel("Contract number")).toHaveValue("CV-E2E-100");
  await expect(page.getByLabel(/^Inspection location/)).toHaveValue(
    "Leeds"
  );
});

test("Incoming opens an existing report from the queue", async ({ page }) => {
  await initializeTheme(page, "light");
  await mockAuthenticatedApi(page, {
    incomingItems: [
      {
        ...incomingItem,
        status: "report_created",
        claimedByMe: true,
        workItemId: "e2e-work-item-100",
        reportId: "e2e-report-100",
      },
    ],
  });
  await page.goto("/incoming");

  await page
    .getByRole("button", { name: "Review CV-E2E-100" })
    .click();
  await page.getByRole("button", { name: "Open report" }).click();

  await expect(page).toHaveURL(/\/reports$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "My reports" })
  ).toBeVisible();
});
