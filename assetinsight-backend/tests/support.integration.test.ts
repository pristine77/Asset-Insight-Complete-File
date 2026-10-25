import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const r2Mocks = vi.hoisted(() => ({
  createPutUrl: vi.fn(),
  createStreamingUpload: vi.fn(),
  abortStreamingUpload: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
  publicUrl: vi.fn((key: string) => `https://support-media.example/${key}`),
}));

vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/r2Storage/r2Upload.js")>();
  return {
    ...actual,
    createR2PresignedPutUrl: r2Mocks.createPutUrl,
    createR2StreamingUpload: r2Mocks.createStreamingUpload,
    headR2Object: r2Mocks.headObject,
    deleteFromR2Strict: r2Mocks.deleteObject,
    getR2PublicUrl: r2Mocks.publicUrl,
  };
});

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let SupportConversation: typeof import("../src/models/supportConversation.model.js")["default"];
let SupportMessage: typeof import("../src/models/supportMessage.model.js")["default"];
let SupportAttachment: typeof import("../src/models/supportAttachment.model.js")["default"];
let cleanupAbandonedSupportAttachments: typeof import("../src/service/supportAttachmentMaintenanceService.js")["cleanupAbandonedSupportAttachments"];

const authHeader = (id: string, role: "user" | "admin" | "superadmin" = "user") => ({
  Authorization: `Bearer ${jwt.sign({ id, role }, process.env.JWT_SECRET!, {
    expiresIn: "30m",
  })}`,
});

async function createUser(
  email: string,
  role: "user" | "admin" | "superadmin" = "user",
  overrides: Record<string, unknown> = {}
) {
  return User.create({
    email,
    username: email.split("@")[0],
    password: "Password123!",
    authProvider: "email",
    isVerified: true,
    role,
    ...overrides,
  });
}

async function createConversation(userId: string, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/support/conversations")
    .set(authHeader(userId))
    .send({
      subject: "Camera crashes on save",
      category: "error",
      source: "mobile",
      message: "The app closes after I save the third image.",
      diagnostics: {
        appVersion: "4.2.0",
        platform: "android",
        screen: "AssetCapture",
        errorCode: "CAMERA_SAVE_FAILED",
        occurredAt: "2026-08-16T12:00:00.000Z",
        secretToken: "must-not-be-persisted",
      },
      ...overrides,
    });
}

function bmffSignature(brand: string): Buffer {
  const prefix = Buffer.alloc(24);
  prefix.writeUInt32BE(24, 0);
  prefix.write("ftyp", 4, "ascii");
  prefix.write(brand, 8, 4, "ascii");
  prefix.write(brand, 16, 4, "ascii");
  return prefix;
}

beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  process.env.R2_BUCKET_NAME = "support-test";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: SupportConversation } = await import(
    "../src/models/supportConversation.model.js"
  ));
  ({ default: SupportMessage } = await import("../src/models/supportMessage.model.js"));
  ({ default: SupportAttachment } = await import("../src/models/supportAttachment.model.js"));
  ({ cleanupAbandonedSupportAttachments } = await import(
    "../src/service/supportAttachmentMaintenanceService.js"
  ));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  r2Mocks.createPutUrl.mockReset();
  r2Mocks.createStreamingUpload.mockReset();
  r2Mocks.abortStreamingUpload.mockReset();
  r2Mocks.headObject.mockReset();
  r2Mocks.deleteObject.mockReset();
  r2Mocks.publicUrl.mockClear();
  r2Mocks.createPutUrl.mockResolvedValue("https://r2-upload.example/signed-put");
  r2Mocks.createStreamingUpload.mockImplementation(({ body }) => ({
    done: async () => {
      for await (const _chunk of body) {
        // Consuming the stream models the SDK's backpressure without buffering.
      }
    },
    abort: r2Mocks.abortStreamingUpload,
  }));
  r2Mocks.abortStreamingUpload.mockResolvedValue(undefined);
  r2Mocks.deleteObject.mockResolvedValue(undefined);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("support chat platform", () => {
  it("creates a diagnostic request, enforces ownership and makes retries idempotent", async () => {
    const owner = await createUser("owner@example.test");
    const stranger = await createUser("stranger@example.test");
    const admin = await createUser("agent@example.test", "admin", {
      canManageSupport: true,
    });

    const created = await createConversation(String(owner._id));
    expect(created.status).toBe(201);
    expect(created.body.conversation).toMatchObject({
      subject: "Camera crashes on save",
      category: "error",
      source: "mobile",
      status: "open",
      unread: { user: 0 },
      messageCount: 1,
    });
    expect(created.body.conversation).not.toHaveProperty("priority");
    expect(created.body.conversation).not.toHaveProperty("user");
    expect(created.body.conversation).not.toHaveProperty("assignee");
    expect(created.body.conversation).not.toHaveProperty("diagnostics");
    expect(created.body.conversation.unread).not.toHaveProperty("agent");
    expect(created.body.initialMessage.body).toContain("third image");
    expect(created.body.initialMessage).not.toHaveProperty("sender");
    expect(created.body.initialMessage).not.toHaveProperty("diagnostics");
    const conversationId = created.body.conversation.id;
    const storedConversation = await SupportConversation.findById(conversationId).lean();
    expect(storedConversation?.diagnostics).toMatchObject({
      appVersion: "4.2.0",
      platform: "android",
      screen: "AssetCapture",
      errorCode: "CAMERA_SAVE_FAILED",
    });
    expect(storedConversation?.diagnostics).not.toHaveProperty("secretToken");

    const unauthorized = await request(app).get(`/api/support/conversations/${conversationId}`);
    expect(unauthorized.status).toBe(401);

    const hidden = await request(app)
      .get(`/api/support/conversations/${conversationId}`)
      .set(authHeader(String(stranger._id)));
    expect(hidden.status).toBe(404);

    const firstSend = await request(app)
      .post(`/api/support/conversations/${conversationId}/messages`)
      .set(authHeader(String(owner._id)))
      .send({ body: "This retry must only save once.", clientMessageId: "mobile-42" });
    expect(firstSend.status).toBe(201);
    const retry = await request(app)
      .post(`/api/support/conversations/${conversationId}/messages`)
      .set(authHeader(String(owner._id)))
      .send({ body: "This retry must only save once.", clientMessageId: "mobile-42" });
    expect(retry.status).toBe(200);
    expect(retry.body.message.id).toBe(firstSend.body.message.id);
    expect(await SupportMessage.countDocuments({ conversation: conversationId })).toBe(2);

    const queue = await request(app)
      .get("/api/support/admin/conversations?status=open")
      .set(authHeader(String(admin._id), "admin"));
    expect(queue.status).toBe(200);
    expect(queue.body.items).toHaveLength(1);
    expect(queue.body.items[0].user.email).toBe("owner@example.test");

    const reply = await request(app)
      .post(`/api/support/admin/conversations/${conversationId}/messages`)
      .set(authHeader(String(admin._id), "admin"))
      .send({ body: "Thanks—we are investigating this now." });
    expect(reply.status).toBe(201);
    expect(reply.body.message.senderRole).toBe("agent");

    const note = await request(app)
      .post(`/api/support/admin/conversations/${conversationId}/notes`)
      .set(authHeader(String(admin._id), "admin"))
      .send({ body: "Likely related to the Android camera lifecycle." });
    expect(note.status).toBe(201);
    expect(note.body.message.type).toBe("internal_note");

    const ownerMessages = await request(app)
      .get(`/api/support/conversations/${conversationId}/messages`)
      .set(authHeader(String(owner._id)));
    expect(ownerMessages.status).toBe(200);
    expect(ownerMessages.body.items.map((item: any) => item.type)).not.toContain("internal_note");
    expect(ownerMessages.body.items).toHaveLength(3);
    for (const item of ownerMessages.body.items) {
      expect(item).not.toHaveProperty("sender");
      expect(item).not.toHaveProperty("diagnostics");
    }

    const adminMessages = await request(app)
      .get(`/api/support/admin/conversations/${conversationId}/messages`)
      .set(authHeader(String(admin._id), "admin"));
    expect(adminMessages.body.items.map((item: any) => item.type)).toContain("internal_note");

    const markRead = await request(app)
      .post(`/api/support/conversations/${conversationId}/read`)
      .set(authHeader(String(owner._id)))
      .send({});
    expect(markRead.body).toEqual({ unreadCount: 0 });
    expect((await SupportConversation.findById(conversationId).lean())?.userUnreadCount).toBe(0);
  });

  it("requires an explicit developer capability while preserving requester ownership", async () => {
    const owner = await createUser("capability-owner@example.test");
    const unflaggedAdmin = await createUser("requester-admin@example.test", "admin");
    const unflaggedSuperadmin = await createUser(
      "requester-superadmin@example.test",
      "superadmin"
    );
    const developer = await createUser("support-developer@example.test", "admin", {
      canManageSupport: true,
    });
    expect(unflaggedAdmin.canManageSupport).toBe(false);
    expect(unflaggedSuperadmin.canManageSupport).toBe(false);

    const ownerConversation = await createConversation(String(owner._id));
    const ownerConversationId = ownerConversation.body.conversation.id;

    const adminDenied = await request(app)
      .get("/api/support/admin/constraints")
      .set(authHeader(String(unflaggedAdmin._id), "admin"));
    expect(adminDenied.status).toBe(403);
    expect(adminDenied.body).toMatchObject({ code: "SUPPORT_DEVELOPER_REQUIRED" });

    const superadminDenied = await request(app)
      .get("/api/support/admin/conversations")
      .set(authHeader(String(unflaggedSuperadmin._id), "superadmin"));
    expect(superadminDenied.status).toBe(403);
    expect(superadminDenied.body).toMatchObject({ code: "SUPPORT_DEVELOPER_REQUIRED" });

    // An administrator without the capability remains a normal requester on
    // the customer routes and sees only conversations owned by that account.
    const adminRequest = await createConversation(String(unflaggedAdmin._id), {
      subject: "Admin portal request",
      source: "web",
      message: "Please help with an admin portal issue.",
    });
    expect(adminRequest.status).toBe(201);
    const adminList = await request(app)
      .get("/api/support/conversations")
      .set(authHeader(String(unflaggedAdmin._id), "admin"));
    expect(adminList.status).toBe(200);
    expect(adminList.body.items).toHaveLength(1);
    expect(adminList.body.items[0]).toMatchObject({
      id: adminRequest.body.conversation.id,
      subject: "Admin portal request",
    });
    expect(adminList.body.items[0]).not.toHaveProperty("priority");
    expect(adminList.body.items[0]).not.toHaveProperty("assignee");
    expect(adminList.body.items[0]).not.toHaveProperty("diagnostics");
    expect(adminList.body.items[0].unread).not.toHaveProperty("agent");
    const otherCustomerConversation = await request(app)
      .get(`/api/support/conversations/${ownerConversationId}`)
      .set(authHeader(String(unflaggedAdmin._id), "admin"));
    expect(otherCustomerConversation.status).toBe(404);

    const queue = await request(app)
      .get("/api/support/admin/conversations")
      .set(authHeader(String(developer._id), "admin"));
    expect(queue.status).toBe(200);
    expect(queue.body.items).toHaveLength(2);

    const agents = await request(app)
      .get("/api/support/admin/agents")
      .set(authHeader(String(developer._id), "admin"));
    expect(agents.status).toBe(200);
    expect(agents.body.items.map((agent: any) => agent.id)).toEqual([
      String(developer._id),
    ]);

    const invalidConversationAssignee = await request(app)
      .patch(`/api/support/admin/conversations/${ownerConversationId}`)
      .set(authHeader(String(developer._id), "admin"))
      .send({ assigneeId: String(unflaggedAdmin._id) });
    expect(invalidConversationAssignee.status).toBe(400);
    expect(invalidConversationAssignee.body).toMatchObject({ code: "INVALID_ASSIGNEE" });

    const validConversationAssignee = await request(app)
      .patch(`/api/support/admin/conversations/${ownerConversationId}`)
      .set(authHeader(String(developer._id), "admin"))
      .send({ assigneeId: String(developer._id) });
    expect(validConversationAssignee.status).toBe(200);
    expect(validConversationAssignee.body.conversation.assignee.id).toBe(
      String(developer._id)
    );

    const invalidTodoAssignee = await request(app)
      .post(`/api/support/admin/conversations/${ownerConversationId}/todos`)
      .set(authHeader(String(developer._id), "admin"))
      .send({ title: "Restricted assignment", assigneeId: String(unflaggedSuperadmin._id) });
    expect(invalidTodoAssignee.status).toBe(400);
    expect(invalidTodoAssignee.body).toMatchObject({ code: "INVALID_ASSIGNEE" });
  });

  it("supports agent workflow, todos, activity and dashboard counts", async () => {
    const owner = await createUser("workflow-owner@example.test");
    const admin = await createUser("workflow-agent@example.test", "admin", {
      canManageSupport: true,
    });
    const created = await createConversation(String(owner._id), {
      subject: "Add bulk export",
      category: "feature",
      source: "web",
      message: "We need a CSV bulk export for completed appraisals.",
    });
    const conversationId = created.body.conversation.id;

    const patched = await request(app)
      .patch(`/api/support/admin/conversations/${conversationId}`)
      .set(authHeader(String(admin._id), "admin"))
      .send({ status: "in_progress", priority: "high", assigneeId: String(admin._id) });
    expect(patched.status).toBe(200);
    expect(patched.body.conversation).toMatchObject({
      status: "in_progress",
      priority: "high",
      assignee: { id: String(admin._id) },
    });

    const createdTodo = await request(app)
      .post(`/api/support/admin/conversations/${conversationId}/todos`)
      .set(authHeader(String(admin._id), "admin"))
      .send({
        title: "Reproduce export volume",
        priority: "high",
        assigneeId: String(admin._id),
        dueAt: "2026-08-20T12:00:00.000Z",
      });
    expect(createdTodo.status).toBe(201);
    expect(createdTodo.body.todo.status).toBe("todo");

    const completedTodo = await request(app)
      .patch(
        `/api/support/admin/conversations/${conversationId}/todos/${createdTodo.body.todo.id}`
      )
      .set(authHeader(String(admin._id), "admin"))
      .send({ status: "done" });
    expect(completedTodo.status).toBe(200);
    expect(completedTodo.body.todo.completedAt).toBeTruthy();

    const followUpTodo = await request(app)
      .post(`/api/support/admin/conversations/${conversationId}/todos`)
      .set(authHeader(String(admin._id), "admin"))
      .send({
        title: "Draft API contract",
        priority: "normal",
      });
    expect(followUpTodo.status).toBe(201);

    const myTodos = await request(app)
      .get("/api/support/admin/todos?status=active&assigneeId=me")
      .set(authHeader(String(admin._id), "admin"));
    expect(myTodos.status).toBe(200);
    expect(myTodos.body.items).toHaveLength(1);
    expect(myTodos.body.items[0]).toMatchObject({
      title: "Draft API contract",
      conversation: {
        id: conversationId,
        subject: "Add bulk export",
        user: { id: String(owner._id) },
      },
    });

    const activity = await request(app)
      .get(`/api/support/admin/conversations/${conversationId}/activity`)
      .set(authHeader(String(admin._id), "admin"));
    expect(activity.status).toBe(200);
    const types = activity.body.items.map((item: any) => item.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "conversation_created",
        "status_changed",
        "priority_changed",
        "assignee_changed",
        "todo_created",
        "todo_updated",
      ])
    );

    const dashboard = await request(app)
      .get("/api/support/admin/dashboard")
      .set(authHeader(String(admin._id), "admin"));
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.dashboard.conversations).toMatchObject({
      total: 1,
      unassigned: 0,
      statuses: { in_progress: 1 },
      priorities: { high: 1 },
    });
    expect(dashboard.body.dashboard.todos.open).toBe(1);
    expect(dashboard.body.dashboard.recentTodos[0].title).toBe("Draft API contract");
    expect(dashboard.body.dashboard.recentActivity[0]).toMatchObject({
      conversation: { id: conversationId, subject: "Add bulk export" },
    });
  });

  it("publishes attachment render URLs only after exact R2 HEAD confirmation", async () => {
    const owner = await createUser("media-owner@example.test");
    const stranger = await createUser("media-stranger@example.test");
    const created = await createConversation(String(owner._id));
    const conversationId = created.body.conversation.id;

    const invalid = await request(app)
      .post(`/api/support/conversations/${conversationId}/attachments/presign`)
      .set(authHeader(String(owner._id)))
      .send({ fileName: "payload.exe", contentType: "application/octet-stream", sizeBytes: 20 });
    expect(invalid.status).toBe(415);

    const oversized = await request(app)
      .post(`/api/support/conversations/${conversationId}/attachments/presign`)
      .set(authHeader(String(owner._id)))
      .send({ fileName: "huge.jpg", contentType: "image/jpeg", sizeBytes: 21 * 1024 * 1024 });
    expect(oversized.status).toBe(413);

    const presigned = await request(app)
      .post(`/api/support/conversations/${conversationId}/attachments/presign`)
      .set(authHeader(String(owner._id)))
      .send({ fileName: "crash screenshot.png", contentType: "image/png", sizeBytes: 1234 });
    expect(presigned.status).toBe(201);
    expect(presigned.body).toMatchObject({
      attachment: {
        type: "image",
        originalName: "crash screenshot.png",
        contentType: "image/png",
        sizeBytes: 1234,
        status: "pending",
      },
      upload: {
        url: "https://r2-upload.example/signed-put",
        method: "PUT",
        headers: { "Content-Type": "image/png", "If-None-Match": "*" },
        expiresInSeconds: 900,
      },
    });
    expect(presigned.body.attachment).not.toHaveProperty("url");
    expect(r2Mocks.createPutUrl).toHaveBeenCalledWith(
      "support-test",
      expect.stringMatching(new RegExp(`^support/${conversationId}/`)),
      "image/png",
      900,
      { preventOverwrite: true }
    );
    const attachmentId = presigned.body.attachment.id;
    const storedAttachment: any = await SupportAttachment.findById(attachmentId).lean();
    expect(storedAttachment).toMatchObject({
      r2Bucket: "support-test",
      r2PublicBaseUrl: "https://assetinsight.test",
    });

    const crossUser = await request(app)
      .post(
        `/api/support/conversations/${conversationId}/attachments/${attachmentId}/confirm`
      )
      .set(authHeader(String(stranger._id)))
      .send({});
    expect(crossUser.status).toBe(404);

    r2Mocks.headObject.mockResolvedValue({ size: 1234, contentType: "image/png" });
    const confirmed = await request(app)
      .post(
        `/api/support/conversations/${conversationId}/attachments/${attachmentId}/confirm`
      )
      .set(authHeader(String(owner._id)))
      .send({});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.attachment).toMatchObject({
      id: attachmentId,
      status: "ready",
      verifiedSizeBytes: 1234,
      url: expect.stringMatching(/^https:\/\/support-media\.example\/support\//),
    });

    const message = await request(app)
      .post(`/api/support/conversations/${conversationId}/messages`)
      .set(authHeader(String(owner._id)))
      .send({ attachmentIds: [attachmentId], clientMessageId: "attachment-message-1" });
    expect(message.status).toBe(201);
    expect(message.body.message.attachments[0]).toMatchObject({
      id: attachmentId,
      type: "image",
      status: "ready",
      url: confirmed.body.attachment.url,
    });

    const reuse = await request(app)
      .post(`/api/support/conversations/${conversationId}/messages`)
      .set(authHeader(String(owner._id)))
      .send({ body: "Reuse", attachmentIds: [attachmentId] });
    expect(reuse.status).toBe(409);
    expect(reuse.body.code).toBe("ATTACHMENT_NOT_READY");
  });

  it("finishes metadata-free attachment uploads against the legacy storage target", async () => {
    const owner = await createUser("legacy-confirm@example.test");
    const created = await createConversation(String(owner._id));
    const conversationId = created.body.conversation.id;
    const attachmentId = new mongoose.Types.ObjectId();
    const stored: any = await SupportAttachment.create({
      _id: attachmentId,
      conversation: conversationId,
      uploader: owner._id,
      uploaderRole: "user",
      type: "image",
      status: "pending",
      key: `support/${conversationId}/${attachmentId}/before-cutover.png`,
      originalName: "before-cutover.png",
      contentType: "image/png",
      declaredSizeBytes: 321,
      uploadExpiresAt: new Date(Date.now() + 15 * 60_000),
    });
    expect(stored.toObject()).not.toHaveProperty("r2Bucket");
    expect(stored.toObject()).not.toHaveProperty("r2PublicBaseUrl");
    expect(r2Mocks.createPutUrl).not.toHaveBeenCalled();
    r2Mocks.headObject.mockResolvedValue({ size: 321, contentType: "image/png" });

    const confirmed = await request(app)
      .post(`/api/support/conversations/${conversationId}/attachments/${attachmentId}/confirm`)
      .set(authHeader(String(owner._id)))
      .send({});

    expect(confirmed.status).toBe(200);
    expect(r2Mocks.headObject).toHaveBeenCalledWith("sellsnap-test", stored.key);
    expect(r2Mocks.publicUrl).toHaveBeenCalledWith(
      stored.key,
      expect.objectContaining({
        bucketName: "sellsnap-test",
        publicBaseUrl: "https://images.sellsnap.test",
        generation: "legacy",
      })
    );
  });

  it("streams authenticated customer and agent uploads through the API before publishing them", async () => {
    const owner = await createUser("stream-owner@example.test");
    const stranger = await createUser("stream-stranger@example.test");
    const admin = await createUser("stream-agent@example.test", "admin", {
      canManageSupport: true,
    });
    const created = await createConversation(String(owner._id));
    const conversationId = created.body.conversation.id;

    const customerBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    r2Mocks.headObject.mockResolvedValueOnce({
      size: customerBytes.length,
      contentType: "image/png",
    });
    const customerUpload = await request(app)
      .post(`/api/support/conversations/${conversationId}/attachments/upload`)
      .query({ fileName: "crash screen.png" })
      .set(authHeader(String(owner._id)))
      .set("Content-Type", "image/png")
      .set("X-File-Size", String(customerBytes.length))
      .send(customerBytes);

    expect(customerUpload.status).toBe(201);
    expect(customerUpload.body).toEqual({
      attachment: expect.objectContaining({
        type: "image",
        originalName: "crash screen.png",
        contentType: "image/png",
        sizeBytes: customerBytes.length,
        verifiedSizeBytes: customerBytes.length,
        status: "ready",
        url: expect.stringMatching(/^https:\/\/support-media\.example\/support\//),
      }),
    });
    expect(r2Mocks.createStreamingUpload).toHaveBeenCalledWith({
      bucketName: "support-test",
      key: expect.stringMatching(new RegExp(`^support/${conversationId}/`)),
      body: expect.anything(),
      contentType: "image/png",
      contentLength: customerBytes.length,
    });

    const streamedAttachmentId = customerUpload.body.attachment.id;
    const customerMessage = await request(app)
      .post(`/api/support/conversations/${conversationId}/messages`)
      .set(authHeader(String(owner._id)))
      .send({
        body: "The streamed screenshot is attached.",
        attachmentIds: [streamedAttachmentId],
        clientMessageId: "streamed-attachment-message",
      });
    expect(customerMessage.status).toBe(201);
    expect(customerMessage.body.message.attachments).toEqual([
      expect.objectContaining({
        id: streamedAttachmentId,
        type: "image",
        status: "ready",
        url: customerUpload.body.attachment.url,
      }),
    ]);

    const customerThread = await request(app)
      .get(`/api/support/conversations/${conversationId}/messages`)
      .set(authHeader(String(owner._id)));
    const agentThread = await request(app)
      .get(`/api/support/admin/conversations/${conversationId}/messages`)
      .set(authHeader(String(admin._id), "admin"));
    for (const thread of [customerThread, agentThread]) {
      expect(thread.status).toBe(200);
      expect(thread.body.items.at(-1)?.attachments).toEqual([
        expect.objectContaining({
          id: streamedAttachmentId,
          type: "image",
          url: customerUpload.body.attachment.url,
        }),
      ]);
    }

    const agentBytes = bmffSignature("mp42");
    r2Mocks.headObject.mockResolvedValueOnce({
      size: agentBytes.length,
      contentType: "video/mp4",
    });
    const agentUpload = await request(app)
      .post(`/api/support/admin/conversations/${conversationId}/attachments/upload`)
      .query({ fileName: "agent-repro.mp4" })
      .set(authHeader(String(admin._id), "admin"))
      .set("Content-Type", "video/mp4")
      .set("X-File-Size", String(agentBytes.length))
      .send(agentBytes);
    expect(agentUpload.status).toBe(201);
    expect(agentUpload.body.attachment).toMatchObject({
      type: "video",
      status: "ready",
      verifiedSizeBytes: agentBytes.length,
    });

    const crossAccount = await request(app)
      .post(`/api/support/conversations/${conversationId}/attachments/upload`)
      .query({ fileName: "not-mine.png" })
      .set(authHeader(String(stranger._id)))
      .set("Content-Type", "image/png")
      .set("X-File-Size", "1")
      .send(Buffer.from([1]));
    expect(crossAccount.status).toBe(404);
    expect(r2Mocks.createStreamingUpload).toHaveBeenCalledTimes(2);
  });

  it("rejects streaming byte-count mismatches and removes their pending metadata", async () => {
    const owner = await createUser("stream-mismatch@example.test");
    const created = await createConversation(String(owner._id));
    const conversationId = created.body.conversation.id;

    const tooShort = await request(app)
      .post(`/api/support/conversations/${conversationId}/attachments/upload`)
      .query({ fileName: "short.png" })
      .set(authHeader(String(owner._id)))
      .set("Content-Type", "image/png")
      .set("X-File-Size", "4")
      .send(Buffer.from([1, 2, 3]));
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.code).toBe("UPLOAD_SIZE_MISMATCH");

    const tooLong = await request(app)
      .post(`/api/support/conversations/${conversationId}/attachments/upload`)
      .query({ fileName: "long.png" })
      .set(authHeader(String(owner._id)))
      .set("Content-Type", "image/png")
      .set("X-File-Size", "2")
      .send(Buffer.from([1, 2, 3]));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe("UPLOAD_SIZE_MISMATCH");

    expect(r2Mocks.headObject).not.toHaveBeenCalled();
    expect(r2Mocks.deleteObject).toHaveBeenCalledTimes(2);
    expect(r2Mocks.abortStreamingUpload).toHaveBeenCalledTimes(2);
    expect(await SupportAttachment.countDocuments({ conversation: conversationId })).toBe(0);
  });

  it("rejects spoofed streaming media before readiness and cleans up its object key", async () => {
    const owner = await createUser("stream-signature-mismatch@example.test");
    const created = await createConversation(String(owner._id));
    const conversationId = created.body.conversation.id;
    const jpegBytesClaimedAsPng = Buffer.from([
      0xff, 0xd8, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    const response = await request(app)
      .post(`/api/support/conversations/${conversationId}/attachments/upload`)
      .query({ fileName: "spoofed.png" })
      .set(authHeader(String(owner._id)))
      .set("Content-Type", "image/png")
      .set("X-File-Size", String(jpegBytesClaimedAsPng.length))
      .send(jpegBytesClaimedAsPng);

    expect(response.status).toBe(415);
    expect(response.body.code).toBe("ATTACHMENT_SIGNATURE_MISMATCH");
    expect(r2Mocks.headObject).not.toHaveBeenCalled();
    expect(r2Mocks.abortStreamingUpload).toHaveBeenCalledOnce();
    expect(r2Mocks.deleteObject).toHaveBeenCalledOnce();
    expect(await SupportAttachment.countDocuments({ conversation: conversationId })).toBe(0);
  });

  it("returns stable cursor pages in chronological chat order", async () => {
    const owner = await createUser("pagination@example.test");
    const created = await createConversation(String(owner._id));
    const conversationId = created.body.conversation.id;
    for (let index = 1; index <= 4; index += 1) {
      const sent = await request(app)
        .post(`/api/support/conversations/${conversationId}/messages`)
        .set(authHeader(String(owner._id)))
        .send({ body: `Message ${index}`, clientMessageId: `page-${index}` });
      expect(sent.status).toBe(201);
    }

    const newest = await request(app)
      .get(`/api/support/conversations/${conversationId}/messages?limit=2`)
      .set(authHeader(String(owner._id)));
    expect(newest.status).toBe(200);
    expect(newest.body.items.map((item: any) => item.body)).toEqual(["Message 3", "Message 4"]);
    expect(newest.body.nextCursor).toBeTruthy();

    const older = await request(app)
      .get(
        `/api/support/conversations/${conversationId}/messages?limit=2&before=${newest.body.nextCursor}`
      )
      .set(authHeader(String(owner._id)));
    expect(older.body.items.map((item: any) => item.body)).toEqual(["Message 1", "Message 2"]);
  });

  it("reconciles expired pending and abandoned ready R2 objects", async () => {
    const owner = await createUser("cleanup@example.test");
    const created = await createConversation(String(owner._id));
    const conversationId = created.body.conversation.id;
    const pendingResponse = await request(app)
      .post(`/api/support/conversations/${conversationId}/attachments/presign`)
      .set(authHeader(String(owner._id)))
      .send({ fileName: "never-uploaded.png", contentType: "image/png", sizeBytes: 50 });
    const readyResponse = await request(app)
      .post(`/api/support/conversations/${conversationId}/attachments/presign`)
      .set(authHeader(String(owner._id)))
      .send({ fileName: "abandoned.png", contentType: "image/png", sizeBytes: 75 });
    r2Mocks.headObject.mockResolvedValue({ size: 75, contentType: "image/png" });
    await request(app)
      .post(
        `/api/support/conversations/${conversationId}/attachments/${readyResponse.body.attachment.id}/confirm`
      )
      .set(authHeader(String(owner._id)))
      .send({});

    const now = new Date("2026-08-16T18:00:00.000Z");
    await SupportAttachment.updateOne(
      { _id: pendingResponse.body.attachment.id },
      { $set: { uploadExpiresAt: new Date(now.getTime() - 2 * 60 * 60_000) } }
    );
    await SupportAttachment.updateOne(
      { _id: readyResponse.body.attachment.id },
      { $set: { completedAt: new Date(now.getTime() - 25 * 60 * 60_000) } }
    );

    const result = await cleanupAbandonedSupportAttachments({ now });
    expect(result).toMatchObject({ scanned: 2, deleted: 2, failed: 0 });
    expect(r2Mocks.deleteObject).toHaveBeenCalledTimes(2);
    expect(await SupportAttachment.countDocuments({ conversation: conversationId })).toBe(0);
  });

  it("removes abandoned legacy metadata without deleting the legacy R2 object", async () => {
    const owner = await createUser("legacy-cleanup@example.test");
    const created = await createConversation(String(owner._id));
    const conversationId = created.body.conversation.id;
    const pending = await request(app)
      .post(`/api/support/conversations/${conversationId}/attachments/presign`)
      .set(authHeader(String(owner._id)))
      .send({ fileName: "legacy.png", contentType: "image/png", sizeBytes: 50 });
    const now = new Date("2026-08-16T18:00:00.000Z");
    await SupportAttachment.updateOne(
      { _id: pending.body.attachment.id },
      {
        $set: { uploadExpiresAt: new Date(now.getTime() - 2 * 60 * 60_000) },
        $unset: { r2Bucket: "", r2PublicBaseUrl: "" },
      }
    );
    r2Mocks.deleteObject.mockClear();

    const result = await cleanupAbandonedSupportAttachments({ now });

    expect(result).toMatchObject({ scanned: 1, deleted: 1, failed: 0 });
    expect(r2Mocks.deleteObject).not.toHaveBeenCalled();
    expect(await SupportAttachment.countDocuments({ conversation: conversationId })).toBe(0);
  });
});
