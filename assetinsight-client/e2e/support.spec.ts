import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const imageMediaUrl = "https://media.support-e2e.test/support-image.svg";
const videoMediaUrl = "https://media.support-e2e.test/support-video.mp4";
const e2eBaseUrl =
  process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3010";

type ReadyAttachment = {
  id: string;
  type: "image" | "video";
  originalName: string;
  contentType: string;
  sizeBytes: number;
  status: "ready";
  url: string;
  createdAt: string;
};

type Conversation = {
  id: string;
  subject: string;
  category: "error" | "feature" | "question" | "other";
  source: "web";
  status: "open" | "in_progress" | "waiting_on_user" | "resolved" | "closed";
  priority: "normal" | "high";
  user: { id: string; username: string; email: string };
  assignee: { id: string; username: string; email: string } | null;
  lastMessage: { preview: string; at: string; senderRole: "user" | "agent" };
  unread: { user: number; agent: number };
  messageCount: number;
  diagnostics: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

type Message = {
  id: string;
  conversationId: string;
  sender: { id: string; username: string; email: string } | null;
  senderRole: "user" | "agent" | "system";
  type: "message" | "system";
  body: string;
  diagnostics: Record<string, unknown> | null;
  attachments: ReadyAttachment[];
  createdAt: string;
};

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  });
}

async function mockSupportApi(page: Page) {
  await page.context().addCookies([
    { name: "cv_access_token", value: "support-e2e-access", url: e2eBaseUrl },
    { name: "cv_refresh_token", value: "support-e2e-refresh", url: e2eBaseUrl },
    { name: "cv_auth", value: "1", url: e2eBaseUrl },
  ]);
  await page.addInitScript(() => {
    window.localStorage.setItem("cv_access_token", "support-e2e-access");
    window.localStorage.setItem("cv_refresh_token", "support-e2e-refresh");
  });

  const now = "2026-08-16T10:10:00.000Z";
  const existing: Conversation = {
    id: "support-e2e-1",
    subject: "Preview upload fails",
    category: "error",
    source: "web",
    status: "in_progress",
    priority: "high",
    user: {
      id: "support-user",
      username: "Alex Morgan",
      email: "alex@example.test",
    },
    assignee: {
      id: "support-agent",
      username: "Taylor",
      email: "support@example.test",
    },
    lastMessage: {
      preview: "We are checking this now.",
      at: now,
      senderRole: "agent",
    },
    unread: { user: 1, agent: 0 },
    messageCount: 2,
    diagnostics: null,
    createdAt: "2026-08-16T09:00:00.000Z",
    updatedAt: now,
  };
  const conversations = [existing];
  const messages = new Map<string, Message[]>([
    [
      existing.id,
      [
        {
          id: "support-message-user",
          conversationId: existing.id,
          sender: existing.user,
          senderRole: "user",
          type: "message",
          body: "The preview upload stops at 90 percent.",
          diagnostics: null,
          attachments: [],
          createdAt: "2026-08-16T09:00:00.000Z",
        },
        {
          id: "support-message-agent",
          conversationId: existing.id,
          sender: existing.assignee,
          senderRole: "agent",
          type: "message",
          body: "We are checking this now.",
          diagnostics: null,
          attachments: [
            {
              id: "support-existing-image",
              type: "image",
              originalName: "preview-error.png",
              contentType: "image/png",
              sizeBytes: 4096,
              status: "ready",
              url: imageMediaUrl,
              createdAt: now,
            },
          ],
          createdAt: now,
        },
      ],
    ],
  ]);
  const readyAttachments = new Map<string, ReadyAttachment>();
  let nextConversation = 2;
  let nextMessage = 3;
  let nextAttachment = 1;
  let rawUploadCount = 0;
  let authenticatedUploadCount = 0;
  let sizedUploadCount = 0;
  await page.route("https://media.support-e2e.test/**", async (route) => {
    const isVideo = route.request().url().endsWith(".mp4");
    await route.fulfill({
      status: 200,
      contentType: isVideo ? "video/mp4" : "image/svg+xml",
      body: isVideo
        ? Buffer.from("AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29t", "base64")
        : "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180' viewBox='0 0 320 180'><rect width='320' height='180' fill='#dbeafe'/><path d='M30 145l70-70 42 38 48-68 100 100z' fill='#1557ed'/></svg>",
    });
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path.endsWith("/api/user/me")) {
      await json(route, existing.user);
      return;
    }
    if (path.endsWith("/api/auctioneer/status")) {
      await json(route, { enabled: false, configured: false });
      return;
    }
    if (path.endsWith("/api/auctioneer/incoming/summary")) {
      await json(route, { availableCount: 0 });
      return;
    }
    if (path.endsWith("/api/support/constraints")) {
      await json(route, {
        constraints: {
          imageContentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"],
          videoContentTypes: ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"],
          maxImageBytes: 20 * 1024 * 1024,
          maxVideoBytes: 250 * 1024 * 1024,
          maxAttachmentsPerMessage: 8,
          maxPendingUploads: 20,
        },
      });
      return;
    }
    if (path.endsWith("/api/support/conversations") && method === "GET") {
      await json(route, { items: conversations, nextCursor: null });
      return;
    }
    if (path.endsWith("/api/support/conversations") && method === "POST") {
      const input = request.postDataJSON() as {
        subject: string;
        category: Conversation["category"];
        message: string;
        diagnostics?: Record<string, unknown>;
      };
      const id = `support-e2e-${nextConversation++}`;
      const created: Conversation = {
        ...existing,
        id,
        subject: input.subject,
        category: input.category,
        status: "open",
        priority: "normal",
        assignee: null,
        lastMessage: { preview: input.message, at: now, senderRole: "user" },
        unread: { user: 0, agent: 1 },
        messageCount: 1,
        diagnostics: input.diagnostics || null,
      };
      const initialMessage: Message = {
        id: `support-message-${nextMessage++}`,
        conversationId: id,
        sender: existing.user,
        senderRole: "user",
        type: "message",
        body: input.message,
        diagnostics: input.diagnostics || null,
        attachments: [],
        createdAt: now,
      };
      conversations.unshift(created);
      messages.set(id, [initialMessage]);
      await json(route, { conversation: created, initialMessage }, 201);
      return;
    }

    const conversationMatch = path.match(/\/api\/support\/conversations\/([^/]+)$/);
    if (conversationMatch && method === "GET") {
      await json(route, {
        conversation: conversations.find((item) => item.id === conversationMatch[1]),
      });
      return;
    }
    const messageMatch = path.match(/\/api\/support\/conversations\/([^/]+)\/messages$/);
    if (messageMatch && method === "GET") {
      await json(route, {
        items: messages.get(messageMatch[1]) || [],
        nextCursor: null,
      });
      return;
    }
    if (messageMatch && method === "POST") {
      const input = request.postDataJSON() as {
        body?: string;
        attachmentIds?: string[];
      };
      const conversationId = messageMatch[1];
      const created: Message = {
        id: `support-message-${nextMessage++}`,
        conversationId,
        sender: existing.user,
        senderRole: "user",
        type: "message",
        body: input.body || "",
        diagnostics: null,
        attachments: (input.attachmentIds || []).flatMap((id) => {
          const attachment = readyAttachments.get(id);
          return attachment ? [attachment] : [];
        }),
        createdAt: now,
      };
      messages.set(conversationId, [...(messages.get(conversationId) || []), created]);
      const conversation = conversations.find((item) => item.id === conversationId);
      if (conversation) {
        conversation.lastMessage = {
          preview: created.body || `${created.attachments.length} attachments`,
          at: now,
          senderRole: "user",
        };
      }
      await json(route, { message: created }, 201);
      return;
    }
    if (/\/api\/support\/conversations\/[^/]+\/read$/.test(path)) {
      await json(route, { unreadCount: 0 });
      return;
    }

    const uploadMatch = path.match(
      /\/api\/support\/conversations\/([^/]+)\/attachments\/upload$/
    );
    if (uploadMatch && method === "POST") {
      const headers = request.headers();
      const contentType = headers["content-type"] || "application/octet-stream";
      const fileName = url.searchParams.get("fileName") || "attachment";
      const body = request.postDataBuffer();
      const id = `support-attachment-${nextAttachment++}`;
      const isVideo = contentType.startsWith("video/");
      const attachment: ReadyAttachment = {
        id,
        type: isVideo ? "video" : "image",
        originalName: fileName,
        contentType,
        sizeBytes: body?.byteLength || 0,
        status: "ready",
        url: isVideo ? videoMediaUrl : imageMediaUrl,
        createdAt: now,
      };
      readyAttachments.set(id, attachment);
      rawUploadCount += 1;
      if (headers.authorization === "Bearer support-e2e-access") {
        authenticatedUploadCount += 1;
      }
      if (headers["x-file-size"] === String(body?.byteLength || 0)) {
        sizedUploadCount += 1;
      }
      await json(route, { attachment }, 201);
      return;
    }

    await json(route, { data: [] });
  });

  return {
    uploadCounts: () => ({
      rawUploadCount,
      authenticatedUploadCount,
      sizedUploadCount,
    }),
  };
}

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    results.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious"
    )
  ).toEqual([]);
}

test("customer support chat uploads authenticated media, stays fitted, and replies", async ({
  page,
}, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  const api = await mockSupportApi(page);
  const viewport = testInfo.project.use.viewport;
  const singlePane = Boolean(viewport && viewport.width <= 1100);
  await page.goto("/support");

  await expect(page.getByRole("heading", { level: 1, name: "Support" })).toBeVisible();
  if (singlePane) {
    await expect(page.getByRole("button", { name: /Preview upload fails/i })).toBeVisible();
  }
  await page.getByRole("button", { name: /Preview upload fails/i }).click();
  await expect(
    page.getByLabel(/^Support team at/).getByText("We are checking this now.")
  ).toBeVisible();
  await expect(page.getByRole("img", { name: "Attachment: preview-error.png" })).toBeVisible();

  await page.getByLabel("Reply to support").fill("I can reproduce it on another report.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(
    page.getByLabel(/^You at/).last().getByText("I can reproduce it on another report.")
  ).toBeVisible();

  if (singlePane) {
    await page.getByRole("button", { name: "Back to support requests" }).click();
  }
  await page.getByRole("button", { name: "New request" }).click();
  const dialog = page.getByRole("dialog", { name: "New support request" });
  await dialog.getByLabel("Subject").fill("Camera upload stops");
  await dialog
    .getByLabel("Description")
    .fill("The upload remains at 90 percent after I select a recording.");
  await dialog.locator('input[type="file"]').setInputFiles([
    { name: "error.png", mimeType: "image/png", buffer: Buffer.from("screenshot") },
    { name: "workflow.mp4", mimeType: "video/mp4", buffer: Buffer.from("video-proof") },
  ]);
  await dialog.getByRole("button", { name: "Create request" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Camera upload stops" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Attachment: error.png" })).toBeVisible();
  await expect(page.getByLabel("Video attachment: workflow.mp4")).toBeVisible();
  await expect.poll(api.uploadCounts).toEqual({
    rawUploadCount: 2,
    authenticatedUploadCount: 2,
    sizedUploadCount: 2,
  });
  await expectNoSeriousAccessibilityViolations(page);

  const metrics = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    viewportHeight: document.documentElement.clientHeight,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    bodyScrollY: window.scrollY,
    workspace: (() => {
      const element = document.querySelector<HTMLElement>(
        '[aria-label="Support conversations"]'
      );
      const rect = element?.getBoundingClientRect();
      return rect ? { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left } : null;
    })(),
    composer: (() => {
      const element = document.querySelector<HTMLTextAreaElement>("#support-reply")?.form;
      const rect = element?.getBoundingClientRect();
      return rect ? { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left } : null;
    })(),
    messageOverflow: (() => {
      const element = document.querySelector<HTMLElement>('[data-support-scroll="messages"]');
      return element ? element.scrollWidth - element.clientWidth : null;
    })(),
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.bodyScrollY).toBe(0);
  expect(metrics.workspace).not.toBeNull();
  expect(metrics.workspace!.top).toBeGreaterThanOrEqual(0);
  expect(metrics.workspace!.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.workspace!.bottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.composer).not.toBeNull();
  expect(metrics.composer!.bottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.composer!.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.messageOverflow).not.toBeNull();
  expect(metrics.messageOverflow!).toBeLessThanOrEqual(1);
  expect(runtimeErrors).toEqual([]);

  const screenshotDirectory = process.env.SUPPORT_QA_SCREENSHOT_DIR;
  if (screenshotDirectory) {
    await page.screenshot({
      path: `${screenshotDirectory}/support-${testInfo.project.name}.png`,
      fullPage: false,
    });
  }
});
