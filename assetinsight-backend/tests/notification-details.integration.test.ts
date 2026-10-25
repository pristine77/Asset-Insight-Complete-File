import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import notificationsRouter from "../src/routes/notification.routes.js";
import AppNotification from "../src/models/notification.model.js";
import User from "../src/models/user.model.js";

const app = express();
app.use(express.json());
app.use("/api/notifications", notificationsRouter);
let mongo: MongoMemoryServer;
const owner = new mongoose.Types.ObjectId(), other = new mongoose.Types.ObjectId();
const auth = (id: mongoose.Types.ObjectId) => ({ Authorization: `Bearer ${jwt.sign({ id: String(id) }, process.env.JWT_SECRET!, { expiresIn: "15m" })}` });
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await User.collection.insertMany([
    { _id: owner, username: "notification-owner", email: "notification-owner@example.test", role: "admin", isVerified: true },
    { _id: other, username: "notification-other", email: "notification-other@example.test", role: "admin", isVerified: true },
  ] as any);
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

async function notification() {
  return AppNotification.create({ user: owner, category: "report", type: "preview_review_reminder",
    title: "Saved report correction", body: `Hello appraiser,\n\n${"Review the saved value. ".repeat(500)}\nEnd of message.`,
    data: { reportId: "69209256be08b81c6d33e76f", reportType: "LotListing", reportError: "FMV missing for lot 157", correctionSteps: ["Edit the lot value", "Save and resubmit"] },
  });
}

describe("owner-only durable notification details", () => {
  it("returns full plain text/data without reading, sending, or modifying the notification", async () => {
    const note = await notification();
    const before = await AppNotification.collection.findOne({ _id: note._id });
    const response = await request(app).get(`/api/notifications/${note._id}`).set(auth(owner));
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body.item).toMatchObject({ id: String(note._id), title: note.title, body: note.body, read: false, data: note.data });
    expect(response.body.item).not.toHaveProperty("user");
    expect(response.body.item).not.toHaveProperty("deletedAt");
    expect(await AppNotification.collection.findOne({ _id: note._id })).toEqual(before);
    expect(await AppNotification.countDocuments()).toBe(1);
  });

  it("requires authentication and ignores caller-supplied ownership", async () => {
    const note = await notification();
    expect((await request(app).get(`/api/notifications/${note._id}`)).status).toBe(401);
    const denied = await request(app).get(`/api/notifications/${note._id}?userId=${owner}`).set(auth(other)).set("x-user-id", String(owner));
    const absent = await request(app).get(`/api/notifications/${new mongoose.Types.ObjectId()}`).set(auth(other));
    expect(denied.status).toBe(404);
    expect(denied.body).toEqual(absent.body);
    expect(denied.body).toEqual({ message: "Notification not found" });
    expect(denied.headers["cache-control"]).toContain("no-store");
  });

  it("does not expose soft-deleted notifications even to their former inbox owner", async () => {
    const note = await notification();
    await AppNotification.updateOne({ _id: note._id }, { $set: { deletedAt: new Date() } });
    const response = await request(app).get(`/api/notifications/${note._id}`).set(auth(owner));
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: "Notification not found" });
  });

  it.each(["not-an-id", "null", "69209256be08b81c6d33e76fg"])("handles malformed ID %s without a cast exception", async (id) => {
    const response = await request(app).get(`/api/notifications/${id}`).set(auth(owner));
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: "Notification not found" });
  });

  it("preserves normal blocked-account and device-approval gates", async () => {
    const note = await notification();
    await User.updateOne({ _id: owner }, { $set: { isBlocked: true } });
    const blocked = await request(app).get(`/api/notifications/${note._id}`).set(auth(owner));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("ACCOUNT_BLOCKED");
    await User.updateOne({ _id: owner }, { $set: { isBlocked: false, role: "user" } });
    const device = await request(app).get(`/api/notifications/${note._id}`).set(auth(owner));
    expect(device.status).toBe(401);
    expect(device.body.code).toBe("DEVICE_CONTEXT_REQUIRED");
    expect(device.body).not.toHaveProperty("item");
  });

  it("keeps existing list and mark-all-read routes separate", async () => {
    const note = await notification();
    expect((await request(app).get("/api/notifications").set(auth(owner))).body.items).toHaveLength(1);
    expect((await request(app).patch("/api/notifications/read-all").set(auth(owner))).status).toBe(200);
    expect((await request(app).get(`/api/notifications/${note._id}`).set(auth(owner))).body.item.read).toBe(true);
  });
});
