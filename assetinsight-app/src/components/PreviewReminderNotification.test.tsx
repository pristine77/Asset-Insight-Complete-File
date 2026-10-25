import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import PreviewReminderNotification from "./PreviewReminderNotification";
import { previewReminderDetails } from "../utils/previewReminderNotification";
import type { NotificationItem } from "../services/notificationService";
import { fetchNotification } from "../services/notificationService";

jest.mock("../services/notificationService", () => ({ fetchNotification: jest.fn() }));

jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 18, left: 0, right: 0 }) }));
jest.mock("../context/ThemeContext", () => ({ useAppTheme: () => ({ colors: {
  surface: "#fff", overlay: "#0008", border: "#ddd", text: "#111", textSecondary: "#555", accent: "#d11", accentText: "#fff", danger: "#c11", dangerSoft: "#fee",
} }) }));
const reportId = "69209256be08b81c6d33e76f";
const item: NotificationItem = {
  id: "notification-1", category: "report", type: "preview_review_reminder", title: "Preview correction", body: "Old body", createdAt: "2026-09-13T12:00:00Z", read: true,
  data: { subject: "Please review contract 93530", message: "Hello appraiser,\n\nReview the saved preview.\nThank you.", reportError: "FMV missing for lots 1 and 5.", correctionSteps: ["Enter missing values.", "Save and resubmit."], reportId, reportType: "LotListing", contractNo: "93530" },
};

it("renders full notification details without opening or submitting the report automatically", async () => {
  const onOpenPreview = jest.fn(), onClose = jest.fn();
  await render(<PreviewReminderNotification item={item} onClose={onClose} onOpenPreview={onOpenPreview} />);
  expect(screen.getByText(item.data!.message as string)).toBeTruthy();
  expect(screen.getByText("FMV missing for lots 1 and 5.")).toBeTruthy();
  expect(screen.getByText("2. Save and resubmit.")).toBeTruthy();
  expect(screen.getByLabelText("Report notification details")).toBeTruthy();
  expect(onOpenPreview).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Open related preview" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onOpenPreview).toHaveBeenCalledWith(reportId, "LotListing", "pending");
});

it("does not truncate long messages or interpret markup", async () => {
  const message = `<script>Not executable</script>\n${"Review this lot. ".repeat(800)}\nEND`;
  await render(<PreviewReminderNotification item={{ ...item, data: { ...item.data, message } }} onClose={jest.fn()} onOpenPreview={jest.fn()} />);
  const body = screen.getByText(message);
  expect(body.props.numberOfLines).toBeUndefined();
  expect(body.props.selectable).toBe(true);
});

it("keeps missing or malformed related IDs non-actionable and allows closing", async () => {
  const onClose = jest.fn();
  await render(<PreviewReminderNotification item={{ ...item, data: { ...item.data, reportId: "../../report" } }} onClose={onClose} onOpenPreview={jest.fn()} />);
  expect(screen.queryByRole("button", { name: "Open related preview" })).toBeNull();
  await fireEvent.press(screen.getByRole("button", { name: "Close report notification" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("handles legacy body-only reminders and push type metadata without changing other notifications", () => {
  expect(previewReminderDetails({ ...item, data: {} })?.message).toBe("Old body");
  expect(previewReminderDetails({ ...item, type: "", data: { ...item.data, type: "preview_review_reminder" } })?.target?.reportId).toBe(reportId);
  expect(previewReminderDetails({ ...item, type: "crm_task" })).toBeNull();
  expect(previewReminderDetails({ ...item, data: { ...item.data, reportType: "Salvage" } })?.target).toBeNull();
});

it("loads a bounded push envelope before showing its full message and supports explicit retry", async () => {
  jest.mocked(fetchNotification).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(item);
  await render(<PreviewReminderNotification item={{ ...item, requiresDetails: true, body: "Short push", data: { type: "preview_review_reminder" } }} onClose={jest.fn()} onOpenPreview={jest.fn()} />);
  expect(await screen.findByText("The full message could not be loaded. Check your connection and try again.")).toBeTruthy();
  expect(screen.queryByText("Short push")).toBeNull();
  expect(screen.queryByRole("button", { name: "Open related preview" })).toBeNull();
  await fireEvent.press(screen.getByRole("button", { name: "Retry loading message" }));
  expect(await screen.findByText("FMV missing for lots 1 and 5.")).toBeTruthy();
  expect(fetchNotification).toHaveBeenLastCalledWith("notification-1", expect.any(AbortSignal));
});

it("keeps unavailable push details private instead of presenting the short push as complete", async () => {
  jest.mocked(fetchNotification).mockRejectedValueOnce({ response: { status: 404 } });
  await render(<PreviewReminderNotification item={{ ...item, requiresDetails: true }} onClose={jest.fn()} onOpenPreview={jest.fn()} />);
  expect(await screen.findByText("This notification is no longer available for this account.")).toBeTruthy();
  expect(screen.queryByText("FMV missing for lots 1 and 5.")).toBeNull();
});

it.each(["/drafts", "/dashboard"])("routes legacy %s draft reminders to Drafts, never a preview with the draft ID", async (route) => {
  const onOpenDrafts = jest.fn(), onOpenPreview = jest.fn();
  await render(<PreviewReminderNotification item={{ ...item, data: { reportId, reportType: "LotListing", contractNo: "93530", route } }} onClose={jest.fn()} onOpenPreview={onOpenPreview} onOpenDrafts={onOpenDrafts} />);
  expect(screen.getByText(item.body)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open related preview" })).toBeNull();
  await fireEvent.press(screen.getByRole("button", { name: "Open drafts" }));
  expect(onOpenDrafts).toHaveBeenCalledTimes(1);
  expect(onOpenPreview).not.toHaveBeenCalled();
});

it("does not interpret arbitrary dashboard URLs as legacy draft routes", () => {
  for (const route of ["https://example.test/dashboard", "//example.test/dashboard", "/dashboard/other"]) {
    expect(previewReminderDetails({ ...item, data: { ...item.data, route } }))
      .toMatchObject({ isDraft: false, target: { reportId, reportType: "LotListing", mode: "pending" } });
  }
});
