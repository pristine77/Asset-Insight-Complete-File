import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctioneerDeliverySummary } from "@/services/auctioneer";
import AuctioneerDeliveryDialog from "./AuctioneerDeliveryDialog";

const mocks = vi.hoisted(() => ({
  sendDelivery: vi.fn(),
  reconcileDelivery: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/services/auctioneer", () => ({
  default: {
    sendDelivery: mocks.sendDelivery,
    reconcileDelivery: mocks.reconcileDelivery,
  },
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    success: mocks.toastSuccess,
  },
}));

const delivery: AuctioneerDeliverySummary = {
  workItemId: "work-100",
  contractNo: "CV-100",
  reportModel: "AssetReport",
  reportType: "asset",
  state: "ready",
  canSend: true,
};

describe("AuctioneerDeliveryDialog", () => {
  beforeEach(() => {
    mocks.sendDelivery.mockReset();
    mocks.reconcileDelivery.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.sendDelivery.mockResolvedValue({
      ...delivery,
      state: "queued",
    });
  });

  /*
     Several people can be assigned to one contract. An assigned user closes
     THEIR part, and Auctioneer completes the contract once every assigned
     person has closed theirs (owner, 2026-10-02). This replaced a note saying
     the contract "may remain open", which gave no way to say you were done.
  */
  const assignedDelivery: AuctioneerDeliverySummary = {
    ...delivery,
    canCompleteContract: true,
    contractCompletionScope: "user",
  };

  it("offers an assigned user a close-my-part box, unticked, and sends false when left so", async () => {
    const onClose = vi.fn();
    const onUpdated = vi.fn();
    render(
      <AuctioneerDeliveryDialog
        open
        delivery={assignedDelivery}
        onClose={onClose}
        onUpdated={onUpdated}
      />
    );

    const checkbox = await screen.findByRole("checkbox", {
      name: "I've finished this contract — close my part",
    });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(checkbox).toHaveAccessibleDescription(
      /The contract itself closes when every person assigned to it has closed theirs\./
    );
    // Neither the old note nor the whole-contract wording is offered.
    expect(screen.queryByText(/may remain open/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /Mark the contract task complete/ })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.sendDelivery).toHaveBeenCalledWith("work-100", {
        destination: "LottingBoard",
        completeContract: false,
      })
    );
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ state: "queued" })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("asks to close the assigned user's part when they tick the box", async () => {
    render(
      <AuctioneerDeliveryDialog
        open
        delivery={assignedDelivery}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
      />
    );

    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "I've finished this contract — close my part",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.sendDelivery).toHaveBeenCalledWith("work-100", {
        destination: "LottingBoard",
        completeContract: true,
      })
    );
  });

  it("keeps an assigned user's saved close, locked, on a retry", async () => {
    render(
      <AuctioneerDeliveryDialog
        open
        delivery={{ ...assignedDelivery, state: "failed", completeContract: true }}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
      />
    );

    const checkbox = await screen.findByRole("checkbox", {
      name: "I've finished this contract — close my part",
    });
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry delivery" }));

    await waitFor(() =>
      expect(mocks.sendDelivery).toHaveBeenCalledWith("work-100", {
        destination: "LottingBoard",
        completeContract: true,
      })
    );
  });

  it("offers no close to an older server that refuses one, and sends false", async () => {
    render(
      <AuctioneerDeliveryDialog
        open
        delivery={{ ...delivery, canCompleteContract: false, completeContract: true }}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
      />
    );

    await screen.findByRole("button", { name: "Send report" });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.sendDelivery).toHaveBeenCalledWith("work-100", {
        destination: "LottingBoard",
        completeContract: false,
      })
    );
  });

  it("keeps the legacy completion option when capability is unspecified", async () => {
    render(
      <AuctioneerDeliveryDialog
        open
        delivery={delivery}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
      />
    );

    const checkbox = await screen.findByRole("checkbox", {
      name: /Mark the contract task complete/,
    });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.sendDelivery).toHaveBeenCalledWith("work-100", {
        destination: "LottingBoard",
        completeContract: true,
      })
    );
  });

  it.each([
    [
      "report type",
      { reportType: "lotListing" as const, reportModel: "AssetReport" as const },
    ],
    [
      "report model",
      { reportType: undefined, reportModel: "LotListing" as const },
    ],
  ])(
    "describes a Lot Listing delivery without approval or release wording when identified by %s",
    async (_identifier, identity) => {
      render(
        <AuctioneerDeliveryDialog
          open
          delivery={{ ...delivery, ...identity }}
          onClose={vi.fn()}
          onUpdated={vi.fn()}
        />
      );

      expect(
        await screen.findByText(
          /Contract CV-100 will send final generated listing data and photos\./
        )
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/approved and released Asset Listing data/)
      ).not.toBeInTheDocument();
    }
  );

  it("keeps approval and release wording for an Asset Listing delivery", async () => {
    render(
      <AuctioneerDeliveryDialog
        open
        delivery={delivery}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
      />
    );

    expect(
      await screen.findByText(
        /Contract CV-100 will send approved and released Asset Listing data and final report photos\./
      )
    ).toBeInTheDocument();
  });

  it("keeps the full saved delivery failure visible when the dialog is reopened", async () => {
    const savedError =
      "LOT_NUMBER_CONFLICT: Lot number 1 is already assigned within this event.";
    render(
      <AuctioneerDeliveryDialog
        open
        delivery={{ ...delivery, state: "failed", error: savedError }}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
      />
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(savedError);
    expect(screen.getByRole("button", { name: "Retry delivery" })).toBeEnabled();
    expect(mocks.sendDelivery).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "top-level error message",
      data: {
        message: "Lot number 1 is already assigned within this event.",
        code: "LOT_NUMBER_CONFLICT",
      },
      expected:
        "Lot number 1 is already assigned within this event. (LOT_NUMBER_CONFLICT)",
    },
    {
      name: "string error field",
      data: {
        error: "Lot number 1 is already assigned within this event.",
        code: "LOT_NUMBER_CONFLICT",
      },
      expected:
        "Lot number 1 is already assigned within this event. (LOT_NUMBER_CONFLICT)",
    },
    {
      name: "nested error fields",
      data: {
        message: { unsafe: "not a message" },
        error: {
          message: "Lot number 1 is already assigned within this event.",
          code: "LOT_NUMBER_CONFLICT",
        },
      },
      expected:
        "Lot number 1 is already assigned within this event. (LOT_NUMBER_CONFLICT)",
    },
    {
      name: "code already included in the server message",
      data: {
        message:
          "LOT_NUMBER_CONFLICT: Lot number 1 is already assigned within this event.",
        code: "LOT_NUMBER_CONFLICT",
      },
      expected:
        "LOT_NUMBER_CONFLICT: Lot number 1 is already assigned within this event.",
    },
  ])("shows $name without replacing it with Axios status text", async ({ data, expected }) => {
    const onClose = vi.fn();
    const onUpdated = vi.fn();
    mocks.sendDelivery.mockRejectedValueOnce({
      response: { status: 409, data },
      message: "Request failed with status code 409",
    });
    render(
      <AuctioneerDeliveryDialog
        open
        delivery={delivery}
        onClose={onClose}
        onUpdated={onUpdated}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(expected);
    expect(alert.textContent?.match(/LOT_NUMBER_CONFLICT/g)).toHaveLength(1);
    expect(alert).not.toHaveTextContent("status code 409");
    expect(screen.getByRole("dialog", { name: "Send to Auctioneer" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Send report" })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onUpdated).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { response: { data: { message: [], error: { details: { private: "hidden" } }, code: {} } } },
    { response: { data: ["not an error envelope"] } },
    { response: { data: { message: "  ", code: "invalid code <tag>" } } },
  ])("uses a safe fallback for malformed failures: %j", async (failure) => {
    mocks.sendDelivery.mockRejectedValueOnce(failure);
    render(
      <AuctioneerDeliveryDialog
        open
        delivery={delivery}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to queue the Auctioneer delivery."
    );
    expect(screen.queryByText(/private|hidden|\[object Object\]|invalid code/)).not.toBeInTheDocument();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("retains original failed-delivery settings across a rejected retry", async () => {
    const onClose = vi.fn();
    const onUpdated = vi.fn();
    mocks.sendDelivery.mockRejectedValue({
      response: {
        status: 409,
        data: { message: "Lot number 1 is already assigned within this event.", code: "LOT_NUMBER_CONFLICT" },
      },
    });
    render(
      <AuctioneerDeliveryDialog
        open
        delivery={{
          ...delivery,
          state: "failed",
          destination: "OpToDoBoard",
          opTaskDescription: "Inspect before auction",
          completeContract: true,
        }}
        onClose={onClose}
        onUpdated={onUpdated}
      />
    );
    expect(screen.getByRole("combobox", { name: "Destination" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /Operations To-Do note/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Mark the contract task complete/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry delivery" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry delivery" }));

    await waitFor(() => expect(mocks.sendDelivery).toHaveBeenCalledTimes(2));
    expect(mocks.sendDelivery.mock.calls).toEqual([
      ["work-100", { destination: "OpToDoBoard", opTaskDescription: "Inspect before auction", completeContract: true }],
      ["work-100", { destination: "OpToDoBoard", opTaskDescription: "Inspect before auction", completeContract: true }],
    ]);
    expect(onClose).not.toHaveBeenCalled();
    expect(onUpdated).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("shows reconciliation rejection details without closing or announcing success", async () => {
    const onClose = vi.fn();
    const onUpdated = vi.fn();
    mocks.reconcileDelivery.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { error: { message: "The lot belongs to a different contract.", code: "LOT_CONTRACT_MISMATCH" } },
      },
      message: "Request failed with status code 409",
    });
    render(
      <AuctioneerDeliveryDialog
        open
        delivery={{ ...delivery, state: "needs_reconciliation" }}
        onClose={onClose}
        onUpdated={onUpdated}
      />
    );
    fireEvent.change(screen.getByRole("textbox", { name: /Existing Auctioneer lot ID/ }), {
      target: { value: "external-lot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save reconciliation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The lot belongs to a different contract. (LOT_CONTRACT_MISMATCH)"
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onUpdated).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
