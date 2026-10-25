import React from "react";
import { Pressable, Text } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { NotificationProvider, useNotifications } from "./NotificationContext";
import PreviewReminderNotification from "../components/PreviewReminderNotification";
import { fetchNotifications, markNotificationRead } from "../services/notificationService";
import type { NotificationItem } from "../services/notificationService";

jest.mock("./AuthContext", () => ({ useAuth: () => ({ user: { _id: "notification-owner" } }) }));
jest.mock("expo-notifications", () => ({
  setBadgeCountAsync: jest.fn().mockResolvedValue(undefined),
  dismissAllNotificationsAsync: jest.fn().mockResolvedValue(undefined),
  getLastNotificationResponseAsync: jest.fn().mockResolvedValue(null),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));
jest.mock("../services/notificationService", () => ({
  fetchNotifications: jest.fn(), markNotificationRead: jest.fn(),
  registerForPushNotifications: jest.fn().mockResolvedValue(null),
  sendPushTokenToServer: jest.fn(), deleteNotification: jest.fn(), markAllNotificationsRead: jest.fn(),
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 18, left: 0, right: 0 }) }));
jest.mock("./ThemeContext", () => ({ useAppTheme: () => ({ colors: {
  surface: "#fff", overlay: "#0008", border: "#ddd", text: "#111", textSecondary: "#555", accent: "#d11", accentText: "#fff", danger: "#c11", dangerSoft: "#fee",
} }) }));

const reminder: NotificationItem = {
  id: "notification-1", type: "preview_review_reminder", category: "report", read: false,
  title: "Saved report guidance", body: "Full saved message available offline.", createdAt: "2026-09-13T12:00:00Z",
  data: { reportError: "FMV missing for lot 157", reportId: "69209256be08b81c6d33e76f", reportType: "LotListing" },
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function Inbox() {
  const { notifications, openNotification, lastOpenedNotification, clearLastOpenedNotification } = useNotifications();
  return <>
    {notifications.map((item) => <Pressable key={item.id} accessibilityRole="button" onPress={() => { void openNotification(item); }}><Text>Open {item.title}</Text></Pressable>)}
    {lastOpenedNotification?.type === "preview_review_reminder"
      ? <PreviewReminderNotification item={lastOpenedNotification} onClose={clearLastOpenedNotification} onOpenPreview={jest.fn()} />
      : lastOpenedNotification ? <Text>{lastOpenedNotification.body}</Text> : null}
  </>;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(fetchNotifications).mockResolvedValue({ items: [reminder], unreadCount: 1, page: 1, limit: 100, total: 1 });
});

it("opens the full saved reminder before a slow read receipt completes and retains it after rejection", async () => {
  const read = deferred();
  const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.mocked(markNotificationRead).mockReturnValueOnce(read.promise);
  await render(<NotificationProvider><Inbox /></NotificationProvider>);
  await fireEvent.press(await screen.findByRole("button", { name: "Open Saved report guidance" }));
  expect(screen.getByText(reminder.body)).toBeTruthy();
  expect(screen.getByText("FMV missing for lot 157")).toBeTruthy();
  expect(markNotificationRead).toHaveBeenCalledWith(reminder.id);
  // The follow-up refresh may also be slow; neither request gates the open view.
  jest.mocked(fetchNotifications).mockReturnValueOnce(new Promise(() => undefined));
  await act(async () => { read.reject(new Error("offline")); });
  expect(screen.getByText(reminder.body)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open related preview" })).toBeTruthy();
  log.mockRestore();
});

it("opens saved guidance when both the read receipt and refresh fail immediately", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.mocked(markNotificationRead).mockRejectedValueOnce(new Error("offline"));
  await render(<NotificationProvider><Inbox /></NotificationProvider>);
  const open = await screen.findByRole("button", { name: "Open Saved report guidance" });
  jest.mocked(fetchNotifications).mockRejectedValueOnce(new Error("offline refresh"));
  await fireEvent.press(open);
  expect(screen.getByText(reminder.body)).toBeTruthy();
  await waitFor(() => expect(log).toHaveBeenCalledWith("[Notifications] Silent refresh failed:", expect.any(Error)));
  expect(screen.getByText("FMV missing for lot 157")).toBeTruthy();
  log.mockRestore();
});

it("preserves existing read-receipt ordering for unrelated notifications", async () => {
  const read = deferred();
  const crm: NotificationItem = { ...reminder, category: "crm", type: "crm_task", title: "CRM task", body: "CRM navigation handoff", data: {} };
  jest.mocked(fetchNotifications).mockResolvedValue({ items: [crm], unreadCount: 1, page: 1, limit: 100, total: 1 });
  jest.mocked(markNotificationRead).mockReturnValueOnce(read.promise);
  await render(<NotificationProvider><Inbox /></NotificationProvider>);
  await fireEvent.press(await screen.findByRole("button", { name: "Open CRM task" }));
  expect(screen.queryByText(crm.body)).toBeNull();
  await act(async () => { read.resolve(); });
  expect(await screen.findByText(crm.body)).toBeTruthy();
  expect(screen.queryByLabelText("Report notification details")).toBeNull();
});
