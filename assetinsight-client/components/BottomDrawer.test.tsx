import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BottomDrawer from "./BottomDrawer";

function RerenderingDrawer() {
  const [value, setValue] = useState("");

  return (
    <BottomDrawer
      open
      title="Edit report"
      // Deliberately recreated on each keystroke, matching a polling parent.
      onClose={() => undefined}
    >
      <textarea
        aria-label="Damage analysis"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </BottomDrawer>
  );
}

describe("BottomDrawer focus stability", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps focus in a controlled editor when callback props change", async () => {
    render(<RerenderingDrawer />);

    const editor = screen.getByRole("textbox", { name: "Damage analysis" });
    editor.focus();
    fireEvent.change(editor, { target: { value: "Front panel damage" } });

    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor).toHaveValue("Front panel damage");
  });

  it("cannot be dismissed while a server draft save is active", () => {
    const onClose = vi.fn();

    render(
      <BottomDrawer open title="Create report" onClose={onClose} closeDisabled>
        <p>Saving draft</p>
      </BottomDrawer>
    );

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));

    expect(screen.getByRole("button", { name: "Close panel" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
