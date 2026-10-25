import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { CRM_STATUSES, type CrmTaskItem, type CrmTaskUpdateEntry } from "../services/crm";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3010";
const ownerId = "6a0000000000000000000001";
const taskId = "6b0000000000000000000001";
const otherId = "6a0000000000000000000002";
const names = ["Alex Morgan", "Taylor Reed", "Jamie Chen", "Morgan Patel", "Casey Bennett", "Riley Carter", "Avery Knight", "Jordan Lee"];
const stages = ["inspection_required", "contacted", "new_lead", "proposal_submitted", "decision_pending", "inspection_complete", "contacted", "new_lead"] as const;
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = []; pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) || []).toEqual([]);
  await expect(page).toHaveTitle(/Asset Insight/);
  await expect(page.locator("nextjs-portal")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Application error|Runtime Error/ })).toHaveCount(0);
});
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
}
async function fixture(page: Page, options: { crm?: boolean; theme?: string; listError?: boolean; failUpdate?: boolean; dashboardError?: boolean } = {}) {
  const calls: Array<{ path: string; method: string; body: string }> = [];
  const user = { _id: ownerId, username: "Alex Morgan", email: "alex@example.test", role: "user", isCrmAgent: options.crm ?? true, crmAddress: "Saskatoon, Saskatchewan", crmQuadrant: "NW, CENTRAL", crmSpecializations: ["industrial_construction"], companyName: "McDougall Auctioneers" };
  const tasks: CrmTaskItem[] = Array.from({ length: 124 }, (_, index) => ({
    _id: index === 0 ? taskId : (BigInt(`0x${taskId}`) + BigInt(index)).toString(16),
    clientName: index < 8 ? names[index] : `Contact ${index + 1}`,
    companyName: ["Prairie Equipment Ltd.", "North Ridge Farms", "Pinecrest Transport", "Westfield Ag Services", "Harvest Valley Farms", "Central Auctions", "Summit Equipment", "Greenwood Construction"][index % 8],
    status: stages[index % 8], leadSource: index % 2 ? "organic" : "generic", phoneFormatted: "+1 (306) 555-0101", email: "contact@example.test",
    dueDate: index < 14 ? "2026-09-22T17:00:00.000Z" : "2026-09-24T17:00:00.000Z", createdAt: "2026-09-21T14:30:00.000Z", updatedAt: "2026-09-23T10:15:00.000Z", latestComment: ["Site visit confirmed for Thursday.", "Follow up on equipment list.", "Awaiting initial contact."][index % 3], assignedTo: ownerId, updateCount: 42, companyDescription: "Equipment supply and field operations.",
  }));
  const updates: CrmTaskUpdateEntry[] = Array.from({ length: 42 }, (_, index) => ({ _id: (BigInt("0x6c0000000000000000000001") + BigInt(index)).toString(16), comment: index === 0 ? "Site visit confirmed for Thursday." : "Equipment list received.", status: "inspection_required", createdAt: "2026-09-23T10:15:00.000Z", createdBy: index === 0 ? { _id: ownerId, username: "Alex Morgan" } : { _id: otherId, username: "Jordan Lee" } }));
  let connected = true;
  let transferPending = true;
  await page.context().addCookies([{ name: "cv_access_token", value: "crm-fixture-only", url: baseURL }, { name: "cv_refresh_token", value: "crm-fixture-only", url: baseURL }]);
  await page.addInitScript(({ theme }) => {
    localStorage.setItem("cv_access_token", "crm-fixture-only"); localStorage.setItem("cv_refresh_token", "crm-fixture-only"); localStorage.setItem("cv-theme", theme);
  }, { theme: options.theme || "light" });
  // No real API/provider or customer data participates in these tests.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname; const method = request.method();
    calls.push({ path, method, body: request.postData() || "" });
    if (method === "OPTIONS") return json(route, {});
    if (path.endsWith("/auth/login")) {
      if (request.postDataJSON().password === "incorrect-fixture-password") return json(route, { message: "Invalid email or password" }, 401);
      return json(route, { authState: "authenticated", user, accessToken: "crm-fixture-only", refreshToken: "crm-fixture-only" });
    }
    if (path.endsWith("/auth/logout")) return json(route, {});
    if (path.endsWith("/user/me")) return json(route, user);
    if (path.endsWith("/tasks/dashboard")) {
      if (options.dashboardError) return json(route, { message: "Dashboard service temporarily unavailable" }, 503);
      const asOf = "2026-09-23T12:00:00.000Z";
      const overdue = tasks.filter((task) => task.dueDate! < asOf);
      const upcoming = tasks.filter((task) => task.dueDate! >= asOf);
      const minimal = (task: CrmTaskItem) => ({ _id: task._id, clientName: task.clientName, companyName: task.companyName, status: task.status, dueDate: task.dueDate });
      return json(route, { asOf, total: tasks.length, statusCounts: CRM_STATUSES.map((_id) => ({ _id, count: tasks.filter((task) => task.status === _id).length })), leadSourceCounts: { total: tasks.length, generic: tasks.filter((task) => task.leadSource === "generic").length, organic: tasks.filter((task) => task.leadSource === "organic").length }, dueCounts: { overdue: overdue.length, upcoming: upcoming.length }, overdueTasks: overdue.slice(0, 5).map(minimal), upcomingTasks: upcoming.slice(0, 5).map(minimal) });
    }
    if (path.endsWith("/user") && method === "PUT") { Object.assign(user, request.postDataJSON()); if (Array.isArray(user.crmQuadrant)) user.crmQuadrant = user.crmQuadrant.join(", "); return json(route, user); }
    if (path.endsWith("/tasks/my")) {
      if (options.listError) return json(route, { message: "Task service temporarily unavailable" }, 503);
      expect(url.searchParams.get("view")).toBe("summary");
      let filtered = tasks;
      const status = url.searchParams.get("status"); const q = url.searchParams.get("q"); const source = url.searchParams.get("leadSource");
      if (status && status !== "all") filtered = filtered.filter((task) => task.status === status);
      if (q) filtered = filtered.filter((task) => new RegExp(q, "i").test(task.clientName));
      if (source) filtered = filtered.filter((task) => task.leadSource === source);
      if (url.searchParams.get("due") === "overdue") filtered = filtered.filter((task) => task.dueDate! < "2026-09-23T12:00:00.000Z");
      if (url.searchParams.get("due") === "upcoming") filtered = filtered.filter((task) => task.dueDate! >= "2026-09-23T12:00:00.000Z");
      const pageNumber = Number(url.searchParams.get("page")) || 1; const limit = Number(url.searchParams.get("limit")) || 20;
      return json(route, { items: filtered.slice((pageNumber - 1) * limit, pageNumber * limit), total: filtered.length, page: pageNumber, limit });
    }
    if (path.endsWith("/tasks/quick-add")) { const body = request.postDataJSON(); const item = { ...tasks[0], _id: "6b0000000000000000000999", clientName: body.name, phoneRaw: body.phone, notes: body.notes, status: "new_lead", leadSource: "organic" }; tasks.unshift(item as CrmTaskItem); return json(route, { item }, 201); }
    if (path.endsWith("/tasks/transfers/my")) return json(route, { items: transferPending && url.searchParams.get("status") === "pending" ? [{ _id: "6d0000000000000000000001", leadId: tasks[0], fromUserId: { _id: otherId, username: "Jordan Lee" }, status: "pending", note: "Please follow up on the equipment inspection.", createdAt: "2026-09-23T10:00:00.000Z" }] : [] });
    if (path.includes("/tasks/transfers/") && method === "PATCH") { transferPending = false; return json(route, { item: { _id: "6d0000000000000000000001", status: request.postDataJSON().action === "accept" ? "accepted" : "rejected" } }); }
    if (path.endsWith("/transfer/agents")) return json(route, { items: [{ _id: otherId, username: "Jordan Lee", crmAddress: "Regina", crmQuadrant: "SOUTH", crmSpecializations: ["others"] }] });
    if (path.endsWith("/transfer") && method === "POST") return json(route, { item: { _id: "6d0000000000000000000001", status: "pending" } });
    if (path.endsWith("/outlook/status")) return json(route, { connected, configured: true, email: "alex@example.test" });
    if (path.endsWith("/outlook/disconnect")) { connected = false; return json(route, {}); }
    if (path.endsWith("/outlook/auth-url")) return json(route, { authUrl: "https://login.microsoftonline.com/fixture" });
    if (path.endsWith("/outlook/bulk")) { const ids = request.postDataJSON().taskIds as string[]; return json(route, { createdCount: ids.length, failedCount: 0, created: ids.map((taskId) => ({ taskId, eventId: `event-${taskId}`, webLink: "https://outlook.office.com/fixture" })), failed: [] }); }
    if (path.endsWith("/calendar/ms/outlook")) return json(route, { eventId: "fixture-event", webLink: "https://outlook.office.com/fixture" });
    if (path.endsWith("/email/rewrite")) return json(route, { subject: "Equipment follow-up", body: "<p>Hello Alex,</p><p>Please share the equipment list.</p>" });
    const match = path.match(/\/crm\/tasks\/([a-f0-9]{24})(.*)$/);
    if (match) {
      const task = tasks.find((item) => item._id === match[1]);
      if (!task) return json(route, { message: "Task not found" }, 404);
      if (match[2] === "" && method === "GET") return json(route, { item: { ...task, notes: "Inspect fleet equipment. Retain multiline notes.\nContact the site manager before arrival.", contactLocation: "Saskatoon, Saskatchewan", companyDescription: "Equipment supply and field operations.", website: "https://example.test", importData: { equipment_interest: "Tractors and fleet vehicles" } } });
      if (match[2] === "/updates" && method === "GET") { const current = Number(url.searchParams.get("page")) || 1; return json(route, { items: updates.slice((current - 1) * 20, current * 20), total: updates.length, page: current, limit: 20 }); }
      if (match[2] === "/update" && method === "PATCH") {
        if (options.failUpdate) return json(route, { message: "Unable to confirm update" }, 503);
        const body = request.postData() || ""; const comment = body.match(/name="comment"\r\n\r\n([\s\S]*?)\r\n--/)?.[1] || "New follow-up";
        updates.unshift({ ...updates[0], _id: "6c0000000000000000000999", comment }); task.latestComment = comment;
        return json(route, { item: { ...task, updates } });
      }
      if (match[2].startsWith("/updates/") && method === "DELETE") { const entry = updates.find((item) => match[2].includes(item._id!)); if (entry) { entry.isDeleted = true; entry.comment = ""; } return json(route, { item: { ...task, updates } }); }
      if (match[2].startsWith("/updates/") && method === "PATCH") return json(route, { item: { ...task, updates } });
    }
    if (path.includes("/crm/")) return json(route, { message: `Unmocked CRM request: ${method} ${path}` }, 500);
    if (path.includes("/notifications")) return json(route, { items: [], unreadCount: 0, total: 0 });
    if (path.endsWith("/reports/myreports")) return json(route, []);
    if (["/api/asset", "/api/lot-listing", "/api/salvage", "/api/real-estate"].includes(path)) return json(route, { data: [] });
    if (path.endsWith("/reports/dashboard-analytics")) return json(route, { rangeDays: 31, generatedAt: "2026-09-23T12:00:00.000Z", totals: { reports: 0, lots: 0 }, series: [], leaderboard: { entries: [], totals: { users: 0, reports: 0, lots: 0 } } });
    if (path.endsWith("/auctioneer/status")) return json(route, { enabled: false, configured: false });
    if (path.includes("/summary")) return json(route, { availableCount: 0 });
    return json(route, { items: [], total: 0, page: 1, limit: 20 });
  });
  return { calls, user, options };
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.locator('[role="dialog"]').evaluateAll((dialogs) => dialogs.every((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1))).toBe(true);
}
const screenshotDir = process.env.CRM_SCREENSHOT_DIR;
async function shot(page: Page, name: string) {
  if (!screenshotDir) return;
  await page.evaluate(async () => {
    await document.fonts.ready;
    const brand = document.querySelector(".cv-brand-logo");
    const url = brand && getComputedStyle(brand).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
    if (url) { const image = new Image(); image.src = url; await image.decode().catch(() => undefined); }
  });
  await page.screenshot({ path: `${screenshotDir}/${name}.png`, fullPage: false, animations: "disabled" });
}

test("task-first list is bounded, searchable, paginated and accessible", async ({ page }, info) => {
  const state = await fixture(page); await page.goto("/crm/tasks");
  await expect(page.getByText("124 matching tasks")).toBeVisible();
  await expect(page.getByRole("button", { name: "Alex Morgan", exact: true })).toBeVisible();
  expect(state.calls.filter((call) => call.path.includes("/crm/tasks/")).every((call) => call.path.endsWith("/my"))).toBe(true);
  await noOverflow(page); await shot(page, `crm-list-${info.project.name}`);
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Next", exact: true }).click(); await expect(page.getByText("21–40 of 124")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search CRM tasks" }).fill("Taylor"); await expect(page.getByText("1 matching task")).toBeVisible();
  await page.getByRole("button", { name: "Taylor Reed", exact: true }).click(); await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Taylor Reed" })).toBeVisible();
});

test("deep-linked detail preserves editing and performs one explicit save", async ({ page }, info) => {
  const state = await fixture(page, { theme: "dark" }); await page.goto(`/crm?task=${taskId}`);
  await expect(page.getByRole("heading", { name: "Alex Morgan", exact: true })).toBeVisible();
  await expect(page.getByText("Activity · 42")).toBeVisible(); await noOverflow(page); await shot(page, `crm-detail-${info.project.name}-dark`);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByLabel("Comment", { exact: true }).fill("First line\nSecond line retained");
  await page.getByRole("button", { name: "Save update", exact: true }).click();
  await expect(page.getByText("Update saved.", { exact: true })).toBeVisible();
  expect(state.calls.filter((call) => call.path.endsWith("/update") && call.method === "PATCH")).toHaveLength(1);
  const body = state.calls.find((call) => call.path.endsWith("/update") && call.method === "PATCH")!.body;
  expect(body).not.toContain('name="status"'); expect(body).toContain("Second line retained");
  await page.getByRole("tab", { name: "Details", exact: true }).click(); await expect(page.getByText("Equipment supply and field operations.")).toBeVisible();
  await page.getByRole("tab", { name: "Activity", exact: true }).click(); await page.getByRole("button", { name: "Next activity page" }).click(); await expect(page.getByText("Page 2 of 3")).toBeVisible();
});

test("lead and coverage forms plus transfers work without duplicate actions", async ({ page }, info) => {
  const state = await fixture(page); await page.goto("/crm/coverage");
  await page.getByRole("button", { name: "Edit coverage", exact: true }).click(); await expect(page.getByRole("dialog")).toBeVisible(); await noOverflow(page); await shot(page, `crm-coverage-${info.project.name}`);
  await page.getByRole("textbox", { name: "Service address", exact: true }).fill("Saskatoon field office"); await page.getByRole("button", { name: "Save coverage" }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto("/crm/tasks");
  await page.getByRole("button", { name: "Add lead", exact: true }).click(); await page.getByRole("textbox", { name: "Name", exact: true }).fill("Browser fixture lead"); await page.getByRole("textbox", { name: "Phone", exact: true }).fill("3065550101"); await page.getByRole("combobox", { name: "Specialization", exact: true }).selectOption("others"); await noOverflow(page); await shot(page, `crm-add-lead-${info.project.name}`);
  await page.getByRole("button", { name: "Create lead" }).click(); await expect(page.getByRole("heading", { name: "Browser fixture lead", exact: true })).toBeVisible(); expect(state.calls.filter((call) => call.path.endsWith("/quick-add"))).toHaveLength(1);
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.goto("/crm/transfers"); await expect(page.getByText("Transfer requests", { exact: true })).toBeVisible(); await noOverflow(page); await shot(page, `crm-transfers-${info.project.name}`);
  await page.getByRole("button", { name: "Accept", exact: true }).click(); await expect(page.getByText("Transfer accepted. The task is now assigned to you.")).toBeVisible();
});

test("Outlook export requires selection and has explicit receipts", async ({ page }, info) => {
  const state = await fixture(page); await page.goto("/crm?view=outlook"); await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  expect(state.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Export selected" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Select Alex Morgan for Outlook", exact: true }).check(); await noOverflow(page); await shot(page, `crm-outlook-${info.project.name}`);
  if ((page.viewportSize()?.width || 0) > 680) {
    const selectionWidth = await page.getByRole("checkbox", { name: "Select this page for Outlook" }).evaluate((input) => input.closest("th")!.getBoundingClientRect().width);
    expect(selectionWidth).toBeLessThanOrEqual(50);
    const contactWidth = await page.getByRole("columnheader", { name: "Contact", exact: true }).evaluate((header) => header.getBoundingClientRect().width);
    expect(contactWidth).toBeGreaterThan(120);
  }
  await page.getByRole("button", { name: "Export selected" }).click(); await expect(page.getByText("1 created · 0 failed")).toBeVisible(); await expect(page.getByRole("button", { name: "Export selected" })).toBeDisabled();
  expect(state.calls.filter((call) => call.path.endsWith("/outlook/bulk"))).toHaveLength(1);
});

test("CRM access gates and safe list failure", async ({ page }) => {
  const state = await fixture(page, { crm: false }); await page.goto("/crm"); await expect(page.getByRole("heading", { name: "CRM access required" })).toBeVisible();
  expect(state.calls.filter((call) => call.path.includes("/crm/"))).toHaveLength(0);
});

test("a failed save keeps the entered follow-up", async ({ page }) => {
  const state = await fixture(page, { failUpdate: true }); await page.goto(`/crm?task=${taskId}`); await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Keep this note after failure");
  await page.getByRole("button", { name: "Save update", exact: true }).click(); await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Unable to confirm update");
  await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toHaveValue("Keep this note after failure");
  expect(state.calls.filter((call) => call.path.endsWith("/update") && call.method === "PATCH")).toHaveLength(1);
});

test("320px light layout and native-size desktop concept capture", async ({ page }) => {
  await fixture(page); await page.setViewportSize({ width: 1586, height: 992 }); await page.goto("/crm/tasks"); await expect(page.getByText("124 matching tasks")).toBeVisible(); await shot(page, "crm-desktop-reference-size");
  await page.setViewportSize({ width: 320, height: 740 }); await noOverflow(page); await shot(page, "crm-list-320-light");
  await page.getByRole("button", { name: "Alex Morgan", exact: true }).click(); await expect(page.getByRole("dialog")).toBeVisible(); await noOverflow(page); await shot(page, "crm-detail-320-light");
});

test("dark workspace and dirty edit confirmation remain keyboard accessible", async ({ page }, info) => {
  await fixture(page, { theme: "dark" }); await page.goto("/crm/tasks"); await expect(page.getByText("124 matching tasks")).toBeVisible();
  await noOverflow(page); await shot(page, `crm-list-${info.project.name}-dark`);
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Alex Morgan", exact: true }).click();
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Do not lose this draft");
  await page.keyboard.press("Escape"); await expect(page.getByRole("alertdialog", { name: "Discard unsaved changes" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click(); await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toHaveValue("Do not lose this draft");
  await page.getByRole("combobox", { name: "Stage", exact: true }).selectOption("lost"); await page.getByRole("button", { name: "Save update", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Select a reason");
});

test("email rewrite stays editable and opens a mail draft, never sends email", async ({ page }) => {
  const state = await fixture(page); await page.goto(`/crm?task=${taskId}`); await page.getByRole("button", { name: "Email", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Please send equipment list");
  await page.getByRole("button", { name: "Software rewrite" }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Hello Alex,\n\nPlease share the equipment list.");
  await expect(page.getByRole("link", { name: "Open email app" })).toHaveAttribute("href", /^mailto:contact%40example\.test\?/);
  expect(state.calls.filter((call) => call.path.endsWith("/email/rewrite"))).toHaveLength(1);
  expect(state.calls.some((call) => /email.*send|send.*email/.test(call.path))).toBe(false);
});

test("workspace chooser gates CRM and opens its separate compact dashboard", async ({ page }, info) => {
  const state = await fixture(page);
  await page.goto("/"); await expect(page).toHaveURL(/\/workspaces$/);
  await expect(page.getByRole("heading", { name: "Choose your workspace" })).toBeVisible();
  await expect(page.getByRole("complementary")).toHaveCount(0);
  expect(state.calls.some((call) => call.path.includes("/crm/") || call.path.includes("/auctioneer/") || call.path.includes("/report-activity"))).toBe(false);
  await noOverflow(page); await shot(page, `workspace-picker-${info.project.name}`);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("link", { name: "Open CRM", exact: true }).click();
  await expect(page.getByRole("heading", { name: "CRM dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Total leads 124", exact: true })).toBeVisible();
  await noOverflow(page); await shot(page, `crm-dashboard-${info.project.name}-light`);
  expect(state.calls.filter((call) => call.path.includes("/crm/")).map((call) => call.path)).toEqual(["/api/crm/tasks/dashboard"]);
  expect(state.calls.some((call) => call.path.includes("/auctioneer/") || call.path.includes("/report-activity"))).toBe(false);
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("link", { name: "Imported 62", exact: true }).click();
  await expect(page).toHaveURL(/\/crm\/tasks\?status=all&leadSource=generic$/);
  await expect(page.getByRole("combobox", { name: "Task stage" })).toHaveValue("all");
  await expect(page.getByText("62 matching tasks", { exact: true })).toBeVisible();
  await page.goBack(); await expect(page.getByRole("heading", { name: "CRM dashboard" })).toBeVisible();
  await page.getByRole("link", { name: "Overdue 14", exact: true }).click();
  await expect(page.getByText("14 matching tasks", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Due date filter" })).toHaveValue("overdue");
  if ((page.viewportSize()?.width || 0) < 1024) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "Primary navigation" });
  for (const name of ["Dashboard", "Tasks", "Transfers", "Outlook Calendar", "Coverage"]) await expect(sidebar.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /Incoming|My Reports|Approvals|Previews/ })).toHaveCount(0);
  await sidebar.getByRole("link", { name: "Switch workspace, current CRM" }).click();
  await expect(page.getByRole("heading", { name: "Choose your workspace" })).toBeVisible();
  await page.getByRole("link", { name: "Open Listings", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("CRM dashboard dark, narrow and reference-size layouts retain truthful tables and bars", async ({ page }) => {
  await fixture(page, { theme: "dark" }); await page.setViewportSize({ width: 1536, height: 1024 }); await page.goto("/crm");
  await expect(page.getByRole("link", { name: "Total leads 124", exact: true })).toBeVisible();
  await shot(page, "crm-dashboard-reference-dark");
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Light theme", exact: true }).click(); await shot(page, "crm-dashboard-reference-light");
  const tracks = await page.locator('section[aria-labelledby="crm-pipeline-heading"] [aria-hidden="true"]').evaluateAll((elements) => elements.map((element) => ({ x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width })));
  expect(tracks).toHaveLength(8); expect(new Set(tracks.map((track) => track.x))).toHaveProperty("size", 1); expect(new Set(tracks.map((track) => track.width))).toHaveProperty("size", 1);
  await page.setViewportSize({ width: 320, height: 740 }); await noOverflow(page); await shot(page, "crm-dashboard-320-light");
  const followups = await page.getByRole("heading", { name: "Follow-ups", exact: true }).boundingBox();
  const pipeline = await page.getByRole("heading", { name: "Pipeline", exact: true }).boundingBox();
  expect(followups!.y).toBeLessThan(pipeline!.y);
  await page.getByRole("tab", { name: "Next 7 days 110", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("Contact 15");
  await page.getByRole("button", { name: "Use dark theme", exact: true }).click(); await noOverflow(page); await shot(page, "crm-dashboard-320-dark");
  await page.getByRole("heading", { name: "Pipeline", exact: true }).scrollIntoViewIfNeeded(); await noOverflow(page); await shot(page, "crm-pipeline-320-dark");
  await page.goto("/workspaces"); await page.setViewportSize({ width: 1536, height: 1024 }); await shot(page, "workspace-picker-reference-dark");
  await page.getByRole("button", { name: "Use light theme", exact: true }).click(); await shot(page, "workspace-picker-reference-light");
});

test("non-CRM accounts bypass chooser and entitlement revocation hides CRM", async ({ page }) => {
  const state = await fixture(page, { crm: false }); await page.goto("/workspaces"); await expect(page).toHaveURL(/\/dashboard$/);
  expect(state.calls.some((call) => call.path.includes("/crm/"))).toBe(false);
  await page.goto("/crm/tasks"); await expect(page.getByRole("heading", { name: "CRM access required" })).toBeVisible();
  state.user.isCrmAgent = true;
  await page.reload(); await expect(page.getByText("124 matching tasks", { exact: true })).toBeVisible();
  const count = state.calls.filter((call) => call.path.includes("/crm/")).length;
  state.user.isCrmAgent = false;
  await page.reload(); await expect(page.getByRole("heading", { name: "CRM access required" })).toBeVisible();
  expect(state.calls.filter((call) => call.path.includes("/crm/"))).toHaveLength(count);
});

test("dashboard errors stay explicit, retry safely and retain last good counts", async ({ page }) => {
  const state = await fixture(page, { dashboardError: true }); await page.goto("/crm");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Dashboard service temporarily unavailable");
  await expect(page.getByRole("navigation", { name: "CRM lead totals" })).toHaveCount(0);
  state.options.dashboardError = false;
  await page.getByRole("button", { name: "Retry dashboard" }).click();
  await expect(page.getByRole("link", { name: "Total leads 124", exact: true })).toBeVisible();
  state.options.dashboardError = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Showing the last loaded dashboard");
  await expect(page.getByRole("link", { name: "Total leads 124", exact: true })).toBeVisible();
  expect(state.calls.some((call) => call.method !== "GET")).toBe(false);
});

test("shared notification screen keeps CRM mode while report links choose Listings", async ({ page }) => {
  const state = await fixture(page); await page.goto("/crm"); await expect(page.getByRole("link", { name: "Total leads 124", exact: true })).toBeVisible();
  await page.goto("/notifications"); await expect(page.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
  expect(state.calls.some((call) => call.path.includes("/auctioneer/") || call.path.includes("/report-activity"))).toBe(false);
  await page.goto(`/crm?task=${taskId}`); await expect(page).toHaveURL(new RegExp(`/crm/tasks\\?task=${taskId}$`));
  await expect(page.getByRole("heading", { name: "Alex Morgan", exact: true })).toBeVisible();
  await page.goto("/reports?search=93530");
  if ((page.viewportSize()?.width || 0) < 1024) await expect(page.getByRole("link", { name: "Search reports", exact: true })).toBeVisible();
  else await expect(page.getByRole("searchbox", { name: "Search reports, lots, and clients" })).toBeVisible();
  expect(state.calls.some((call) => call.path.endsWith("/auctioneer/status"))).toBe(true);
});

test("chooser and CRM sign out finish, while fresh sign-in uses the chooser", async ({ page }) => {
  const state = await fixture(page); await page.goto("/workspaces");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fworkspaces$/);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Email address", exact: true }).fill("alex@example.test");
  await page.getByLabel("Password", { exact: true }).fill("incorrect-fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Invalid email or password" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  expect(state.calls.some((call) => call.path.endsWith("/auth/refresh-token"))).toBe(false);
  await page.getByLabel("Password", { exact: true }).fill("isolated-fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose your workspace" })).toBeVisible();
  await page.getByRole("link", { name: "Open CRM", exact: true }).click();
  await expect(page.getByRole("link", { name: "Total leads 124", exact: true })).toBeVisible();
  if ((page.viewportSize()?.width || 0) >= 1024) {
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Fcrm$/);
  }
  expect(state.calls.filter((call) => call.path.endsWith("/auth/login"))).toHaveLength(2);
});
