import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { advanceAuthSession } from "@/lib/auth-storage";
import { UserService } from "@/services/user";
import { toast } from "@/components/ui/toast";
import AppraiserProfileSection from "./AppraiserProfileSection";

vi.mock("@/services/user", () => ({ UserService: { updateAppraiserProfile: vi.fn() } }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const profile = { designation: "CPPA", title: "Original" };

describe("Appraiser profile save lifetime", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("locks the submitted text until refresh acknowledges it, then allows the next edit", async () => {
    const pending = deferred();
    vi.mocked(UserService.updateAppraiserProfile).mockReturnValue(pending.promise as never);
    function Harness() {
      const [saved, setSaved] = useState(profile);
      return <AppraiserProfileSection profile={saved} onSaved={() => setSaved({ ...profile, title: "Submitted title" })} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Submitted title" } });
    const save = screen.getByRole("button", { name: "Save designation and title" });
    act(() => { fireEvent.click(save); fireEvent.click(save); });
    expect(UserService.updateAppraiserProfile).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.getByLabelText("Designation")).toBeDisabled();
    await act(async () => pending.resolve());
    expect(screen.getByLabelText("Title")).toHaveValue("Submitted title");
    expect(screen.getByLabelText("Title")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Next edit" } });
    expect(screen.getByRole("button", { name: "Save designation and title" })).toBeEnabled();
  });

  it("keeps submitted text after failure so the user can retry", async () => {
    vi.mocked(UserService.updateAppraiserProfile).mockRejectedValue(new Error("offline"));
    const onSaved = vi.fn();
    render(<AppraiserProfileSection profile={profile} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Keep this" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save designation and title" })));
    expect(screen.getByLabelText("Title")).toHaveValue("Keep this");
    expect(screen.getByRole("button", { name: "Save designation and title" })).toBeEnabled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("does not refresh or toast a response from the previous account session", async () => {
    const pending = deferred();
    vi.mocked(UserService.updateAppraiserProfile).mockReturnValue(pending.promise as never);
    const onSaved = vi.fn();
    render(<AppraiserProfileSection profile={profile} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Old owner edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save designation and title" }));
    advanceAuthSession();
    await act(async () => pending.resolve());
    expect(onSaved).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("ignores the previous keyed owner's completion without changing the new form", async () => {
    const pending = deferred();
    vi.mocked(UserService.updateAppraiserProfile).mockReturnValue(pending.promise as never);
    const onSaved = vi.fn();
    const { rerender } = render(<AppraiserProfileSection key="owner-a" profile={profile} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Old owner edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save designation and title" }));
    rerender(<AppraiserProfileSection key="owner-b" profile={{ title: "Owner B" }} onSaved={onSaved} />);
    await act(async () => pending.resolve());
    expect(screen.getByLabelText("Title")).toHaveValue("Owner B");
    expect(onSaved).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
