import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AuctioneerContinueAction from "./AuctioneerContinueAction";

describe("imported lot creation actions", () => {
  it("keeps close as form submission and continuation as a separate explicit intent", () => {
    const close = vi.fn();
    const next = vi.fn();
    render(<form onSubmit={(event) => { event.preventDefault(); close(); }}>
      <AuctioneerContinueAction disabled={false} onClick={next} />
    </form>);
    fireEvent.click(screen.getByRole("button", { name: "Create Lot & Close" }));
    expect(close).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create Lot & Continue" }));
    expect(next).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(screen.getByText(/after upload acceptance/i)).toHaveTextContent(/review each preview/i);
    expect(screen.getByRole("button", { name: "Create Lot & Close" })).toHaveAttribute("title", expect.stringContaining("contract stays open"));
  });

  it("disables both creation intents during an upload or draft save", () => {
    render(<AuctioneerContinueAction disabled onClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Create Lot & Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create Lot & Continue" })).toBeDisabled();
  });
});
