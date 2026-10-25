import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceNotification } from "@/services/notifications";
import { NotificationsService } from "@/services/notifications";
import { previewReminderDetails } from "@/lib/previewReminderNotification";
import NotificationModal from "./NotificationModal";
import NotificationsPage from "@/app/(main)/notifications/page";

const mocks = vi.hoisted(() => ({ swr: vi.fn(), push: vi.fn() }));
vi.mock("swr", () => ({ default: mocks.swr, mutate: vi.fn().mockResolvedValue(undefined) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/context/AuthContext", () => ({ useAuthContext: () => ({ user: { _id: "owner-1" } }) }));
vi.mock("next/link", () => ({ default: ({ children, prefetch: _prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => <a {...props}>{children}</a> }));
vi.mock("@/services/notifications", () => ({
  notificationCacheKey: () => "/notifications?page=1&limit=10",
  NotificationsService: { list: vi.fn(), markRead: vi.fn().mockResolvedValue(undefined), markAllRead: vi.fn(), remove: vi.fn() },
}));
const reportId = "69209256be08b81c6d33e76f";
const reminder: WorkspaceNotification = {
  id: "notice-1", type: "preview_review_reminder", title: "Report needs correction", body: "Legacy message", read: false, createdAt: "2026-09-13T10:00:00Z",
  data: { subject: "Please review contract 93530", message: "Hello appraiser,\n\nReview your saved lots.\nThank you.", reportError: "FMV missing for lots 1 and 5.", correctionSteps: ["Enter an amount for each missing value.", "Save and resubmit once."], reportId, reportType: "LotListing", contractNo: "93530", route: "javascript:alert(1)" },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.swr.mockReturnValue({ data: { items: [reminder], total: 1, unreadCount: 1 }, isLoading: false });
});

describe("full saved preview notification messages", () => {
  it("opens a full message without navigating and uses an explicit safe related-preview link", () => {
    const onClose = vi.fn();
    render(<NotificationModal onClose={onClose} />);
    fireEvent.click(screen.getByRole("link", { name: /Report needs correction/ }));
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Please review contract 93530" })).toBeVisible();
    expect(screen.getByText("FMV missing for lots 1 and 5.")).toBeVisible();
    expect(screen.getByText("Save and resubmit once.")).toBeVisible();
    expect(screen.getByText(/Hello appraiser/).textContent).toBe(reminder.data!.message);
    expect(screen.getByRole("link", { name: "Open related preview" })).toHaveAttribute("href", `/previews?reportId=${reportId}&reportType=lotListing`);
    fireEvent.click(screen.getByRole("button", { name: "Back to notifications" }));
    expect(screen.getByRole("link", { name: /Report needs correction/ })).toHaveFocus();
    expect(NotificationsService.markRead).toHaveBeenCalledWith("notice-1");
  });

  it("preserves a 12k body and literal markup without creating HTML elements", () => {
    const message = `<script>not executable</script>\n${"Review this lot. ".repeat(800)}\nEND OF MESSAGE`;
    mocks.swr.mockReturnValue({ data: { items: [{ ...reminder, data: { ...reminder.data, message } }] } });
    const { container } = render(<NotificationModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("link", { name: /Report needs correction/ }));
    expect(screen.getByText(/END OF MESSAGE/).textContent).toBe(message);
    expect(container.querySelector("script")).toBeNull();
  });

  it("keeps full details readable even if the read receipt fails", async () => {
    vi.mocked(NotificationsService.markRead).mockRejectedValueOnce(new Error("offline"));
    render(<NotificationModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("link", { name: /Report needs correction/ }));
    expect(await screen.findByText("FMV missing for lots 1 and 5.")).toBeVisible();
  });

  it("lets the notification center expand the same full message and report action", () => {
    render(<NotificationsPage />);
    fireEvent.click(screen.getByText("Read message and report guidance"));
    expect(screen.getByText("FMV missing for lots 1 and 5.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open related preview" })).toBeVisible();
  });

  it("does not change unrelated CRM notification navigation", () => {
    mocks.swr.mockReturnValue({ data: { items: [{ ...reminder, type: "crm_task", title: "CRM task", data: { route: "/incoming" } }] } });
    const onClose = vi.fn();
    render(<NotificationModal onClose={onClose} />);
    fireEvent.click(screen.getByRole("link", { name: /CRM task/ }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Report notification details")).toBeNull();
  });

  it("links canonical CRM task and transfer notices to the new workspace", () => {
    mocks.swr.mockReturnValue({ data: { items: [
      { ...reminder, id: "crm-task", type: "crm_due", title: "Call prospect", data: { taskId: reportId, route: "/incoming" } },
      { ...reminder, id: "crm-transfer", type: "crm_transfer_request", title: "Transfer request", data: { leadId: reportId } },
    ] } });
    render(<NotificationModal onClose={vi.fn()} />);
    expect(screen.getByRole("link", { name: /Call prospect/ })).toHaveAttribute("href", `/crm/tasks?task=${reportId}`);
    expect(screen.getByRole("link", { name: /Transfer request/ })).toHaveAttribute("href", "/crm/transfers");
    expect(NotificationsService.markRead).not.toHaveBeenCalled();
  });

  it("offers the same CRM task link in the full notification center", () => {
    mocks.swr.mockReturnValue({ data: { items: [{ ...reminder, type: "crm_due", title: "Call prospect", data: { taskId: reportId } }], total: 1, unreadCount: 1 } });
    render(<NotificationsPage />);
    expect(screen.getByRole("link", { name: "Open CRM" })).toHaveAttribute("href", `/crm/tasks?task=${reportId}`);
    expect(NotificationsService.markRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Open CRM" }));
    expect(NotificationsService.markRead).toHaveBeenCalledWith("notice-1");
  });

  it.each(["javascript:alert(1)", "../../account", "report-1", ""])("does not create a preview link from invalid id %s", (id) => {
    expect(previewReminderDetails({ ...reminder, data: { ...reminder.data, reportId: id } })?.previewHref).toBeNull();
  });
  it("supports old body-only reminders and rejects unrelated report types", () => {
    expect(previewReminderDetails({ ...reminder, data: {} })?.message).toBe("Legacy message");
    expect(previewReminderDetails({ ...reminder, data: { reportId, reportType: "Salvage" } })?.previewHref).toBeNull();
    expect(previewReminderDetails({ ...reminder, type: undefined, data: { type: "preview_review_reminder", message: "From push" } })?.message).toBe("From push");
  });
  it.each(["/drafts", "/dashboard"])("keeps legacy %s draft reminders linked to Drafts instead of treating their ID as a report", (route) => {
    expect(previewReminderDetails({ ...reminder, data: { reportId, reportType: "LotListing", contractNo: "93530", route } }))
      .toMatchObject({ previewHref: "/drafts", linkLabel: "Open drafts", message: reminder.body });
  });

  it("does not treat arbitrary dashboard URLs as legacy draft reminders", () => {
    for (const route of ["https://example.test/dashboard", "//example.test/dashboard", "/dashboard/other"]) {
      expect(previewReminderDetails({ ...reminder, data: { ...reminder.data, route } }))
        .toMatchObject({ previewHref: `/previews?reportId=${reportId}&reportType=lotListing`, linkLabel: "Open related preview" });
    }
  });
});
