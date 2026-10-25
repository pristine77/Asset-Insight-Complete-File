import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuctioneerIncomingItem,
  AuctioneerWorkItemSetup,
} from "@/services/auctioneer";
import IncomingPage from "./page";
import { advanceAuthSession } from "@/lib/auth-storage";

const mocks = vi.hoisted(() => ({
  getIncoming: vi.fn(),
  getStatus: vi.fn(),
  getIncomingSummary: vi.fn(),
  claim: vi.fn(),
  getSetup: vi.fn(),
  releaseClaim: vi.fn(),
  getCapturePermission: vi.fn(),
  reopenContractPart: vi.fn(),
  routerPush: vi.fn(),
  authUser: {
    _id: "user-1",
    email: "appraiser@example.com",
    username: "Alex Morgan",
  } as {
    _id: string;
    email: string;
    username: string;
  } | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.routerPush,
    replace: vi.fn(),
  }),
}));

vi.mock("@/context/AuthContext", () => ({
  useAuthContext: () => ({
    user: mocks.authUser,
    loading: false,
  }),
}));

vi.mock("@/services/auctioneer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/auctioneer")>();
  const service = {
    getIncoming: mocks.getIncoming,
    getStatus: mocks.getStatus,
    getIncomingSummary: mocks.getIncomingSummary,
    claim: mocks.claim,
    getSetup: mocks.getSetup,
    releaseClaim: mocks.releaseClaim,
    getCapturePermission: mocks.getCapturePermission,
    reopenContractPart: mocks.reopenContractPart,
  };
  return {
    ...actual,
    default: service,
    AuctioneerService: service,
  };
});

const availableItem: AuctioneerIncomingItem = {
  cycleKey: "cycle-100",
  contractId: "contract-100",
  contractNo: "CV-100",
  customerName: "Northfield Plant Ltd",
  eventId: "event-100",
  eventTitle: "Fleet dispersal",
  eventDate: "2026-08-12T10:00:00.000Z",
  location: "Leeds",
  kind: "scheduleA",
  lotCount: 14,
  status: "available",
};

const claimedItem: AuctioneerIncomingItem = {
  ...availableItem,
  cycleKey: "cycle-claimed",
  workItemId: "work-claimed",
  contractNo: "CV-200",
  status: "claimed",
  claimedByMe: true,
  claimedBy: {
    _id: "user-1",
    username: "Alex Morgan",
  },
  selectedReportType: "asset",
};

function setupFor(
  item: AuctioneerIncomingItem,
  reportType: "asset" | "lotListing" = "asset"
): AuctioneerWorkItemSetup {
  return {
    workItemId: item.workItemId || "work-100",
    cycleKey: item.cycleKey,
    kind: item.kind,
    reportType,
    contract: {
      id: item.contractId,
      contractNo: item.contractNo,
      customerName: item.customerName,
      consignorName: item.consignorName,
      salespersonName: item.salespersonName,
      eventId: item.eventId,
      eventTitle: item.eventTitle,
      eventDate: item.eventDate,
      location: item.location,
    },
    lots: [],
  };
}

const swrTestConfig = {
  provider: () => new Map(),
  dedupingInterval: 0,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  shouldRetryOnError: false,
};

function IncomingHarness() {
  return (
    <SWRConfig
      value={swrTestConfig}
    >
      <IncomingPage />
    </SWRConfig>
  );
}

function renderIncoming() {
  return render(<IncomingHarness />);
}

async function selectContract(contractNo: string) {
  const review = await screen.findByRole("button", {
    name: `Review ${contractNo}`,
  });
  fireEvent.click(review);
  const panel = screen.getByRole("complementary", {
    name: "Selected contract",
  });
  await waitFor(() => expect(panel).toHaveAttribute("data-open", "true"));
  return panel;
}

describe("Incoming", () => {
  beforeEach(() => {
    mocks.getIncoming.mockReset();
    mocks.getStatus.mockReset();
    mocks.getIncomingSummary.mockReset();
    mocks.claim.mockReset();
    mocks.getSetup.mockReset();
    mocks.releaseClaim.mockReset();
    mocks.getCapturePermission.mockReset();
    mocks.reopenContractPart.mockReset();
    mocks.routerPush.mockReset();
    window.sessionStorage.clear();
    mocks.authUser = {
      _id: "user-1",
      email: "appraiser@example.com",
      username: "Alex Morgan",
    };

    mocks.getIncoming.mockResolvedValue([availableItem]);
    mocks.getStatus.mockResolvedValue({
      enabled: true,
      configured: true,
      reachable: true,
    });
    mocks.claim.mockResolvedValue(setupFor(availableItem));
    mocks.getSetup.mockResolvedValue(setupFor(claimedItem));
    mocks.releaseClaim.mockResolvedValue(undefined);
    mocks.getCapturePermission.mockResolvedValue({ reopen: { allowed: false, reason: null, reopenUntil: null } });
  });

  it("shows a lightweight loading state until the queue and status resolve", async () => {
    let resolveIncoming!: (items: AuctioneerIncomingItem[]) => void;
    let resolveStatus!: (status: {
      enabled: boolean;
      configured: boolean;
    }) => void;
    mocks.getIncoming.mockReturnValue(
      new Promise<AuctioneerIncomingItem[]>((resolve) => {
        resolveIncoming = resolve;
      })
    );
    mocks.getStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      })
    );

    renderIncoming();
    expect(
      screen.getByRole("status", { name: "" })
    ).toHaveTextContent(/Loading incoming contracts/);

    await act(async () => {
      resolveIncoming([]);
      resolveStatus({ enabled: true, configured: true });
    });
    expect(await screen.findByText("No assigned lots")).toBeInTheDocument();
    expect(mocks.getIncoming).toHaveBeenCalledWith();
  });

  it("renders an empty queue without hiding the workspace", async () => {
    mocks.getIncoming.mockResolvedValue([]);
    renderIncoming();

    expect(await screen.findByRole("heading", { name: "Incoming" })).toBeInTheDocument();
    expect(screen.getByText("No assigned lots")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No Auctioneer lots are currently assigned to your account."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("does not load assigned work until an authenticated user ID exists", async () => {
    mocks.authUser = null;

    renderIncoming();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.getIncoming).not.toHaveBeenCalled();
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  /*
   * OWNER, 2026-09-29: "fix this screen so that it only leaves the contract that
   * has not been sent back to Auctioneer 2.0. Any contract completed moves to
   * completed tab."
   *
   * Everything assigned sat in one list, so a contract whose report had already
   * gone back was mixed in with the ones still waiting and had to be told apart
   * by its status badge. The queue is what somebody works down each morning.
   */
  describe("outstanding and completed", () => {
    const sentItem: AuctioneerIncomingItem = {
      ...claimedItem,
      cycleKey: "cycle-sent",
      workItemId: "work-sent",
      contractNo: "CV-300",
      status: "sent",
    };

    it("leaves only the unsent contracts in the queue", async () => {
      mocks.getIncoming.mockResolvedValue([claimedItem, sentItem]);
      renderIncoming();

      expect(await screen.findByText("CV-200")).toBeVisible();
      expect(screen.queryByText("CV-300")).toBeNull();
    });

    it("moves a sent contract to the completed tab", async () => {
      mocks.getIncoming.mockResolvedValue([claimedItem, sentItem]);
      renderIncoming();

      await screen.findByText("CV-200");
      fireEvent.click(screen.getByRole("tab", { name: /Completed/ }));

      expect(await screen.findByText("CV-300")).toBeVisible();
      expect(screen.queryByText("CV-200")).toBeNull();
    });

    it("counts each tab, so the rows on screen are explained", async () => {
      mocks.getIncoming.mockResolvedValue([claimedItem, sentItem]);
      renderIncoming();

      expect(await screen.findByRole("tab", { name: /Outstanding 1/ })).toBeVisible();
      expect(screen.getByRole("tab", { name: /Completed 1/ })).toBeVisible();
    });

    it("keeps work that was abandoned rather than finished in the queue", async () => {
      /*
       * "sent" is the only finished state. Work given up on is not work
       * completed, and putting it out of sight is the opposite of what somebody
       * needs — it is the row that most wants attention.
       */
      mocks.getIncoming.mockResolvedValue([
        { ...claimedItem, cycleKey: "cycle-abandoned", contractNo: "CV-400", status: "abandoned" },
      ]);
      renderIncoming();

      expect(await screen.findByText("CV-400")).toBeVisible();
    });

    it("says which emptiness it means when everything is done", async () => {
      // Not "no assigned lots" — there are lots, they are simply all finished,
      // and saying so points at the tab that has them.
      mocks.getIncoming.mockResolvedValue([sentItem]);
      renderIncoming();

      expect(await screen.findByText("Everything assigned is done")).toBeVisible();
      expect(
        screen.getByText(/They are on the Completed tab/)
      ).toBeVisible();
    });

    it("says something different when nothing has been sent back yet", async () => {
      mocks.getIncoming.mockResolvedValue([claimedItem]);
      renderIncoming();

      await screen.findByText("CV-200");
      fireEvent.click(screen.getByRole("tab", { name: /Completed/ }));

      expect(await screen.findByText("Nothing sent back yet")).toBeVisible();
    });
  });

  describe("Re-Open completed contracts", () => {
    const sent = { ...claimedItem, status: "sent" as const };
    const allowed = { reopen: { allowed: true, reason: null, reopenUntil: "2026-10-27T15:00:00.000Z" } };
    const reopened = { contractId: sent.contractId, reopened: true, alreadyOpen: false, accessRevision: 2 };
    async function openCompleted() {
      await screen.findByRole("tab", { name: /Completed/ });
      fireEvent.click(screen.getByRole("tab", { name: /Completed/ }));
      return selectContract(sent.contractNo);
    }

    it("requires fresh allowed permission rather than an event date or cached row", async () => {
      mocks.getIncoming.mockResolvedValue([{ ...sent, reopenUntil: "2099-01-01T00:00:00.000Z", eventClosed: false }]);
      renderIncoming();
      const panel = await openCompleted();
      await waitFor(() => expect(mocks.getCapturePermission).toHaveBeenCalledWith(sent.contractId));
      expect(within(panel).queryByRole("button", { name: "Re-Open" })).toBeNull();
      expect(mocks.reopenContractPart).not.toHaveBeenCalled();
    });

    it("uses allowed permission even when the local row has not reached sent status", async () => {
      mocks.getIncoming.mockResolvedValue([claimedItem]);
      mocks.getCapturePermission.mockResolvedValue(allowed);
      renderIncoming();
      const panel = await selectContract(claimedItem.contractNo);
      expect(await within(panel).findByRole("button", { name: "Re-Open" })).toBeEnabled();
      expect(mocks.reopenContractPart).not.toHaveBeenCalled();
    });

    it("rechecks permission, locks double clicks and selects fresh work with its new revision", async () => {
      let finish!: (value: typeof reopened) => void;
      mocks.getIncoming.mockResolvedValueOnce([sent]).mockResolvedValue([
        sent, { ...availableItem, contractId: sent.contractId, cycleKey: "reopen-cycle", kind: "unknown", accessRevision: 2 },
      ]);
      mocks.getCapturePermission.mockResolvedValue(allowed);
      mocks.reopenContractPart.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      renderIncoming();
      const panel = await openCompleted();
      const button = await within(panel).findByRole("button", { name: "Re-Open" });
      expect(within(panel).getByText(/Re-open until 27 Oct.*9:00/)).toHaveTextContent("Saskatchewan");
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(mocks.reopenContractPart).toHaveBeenCalledExactlyOnceWith(sent.contractId));
      expect(mocks.getCapturePermission).toHaveBeenCalledTimes(2);
      expect(mocks.claim).not.toHaveBeenCalled();
      await act(async () => finish(reopened));
      await waitFor(() => expect(screen.getByRole("tab", { name: /Outstanding/ })).toHaveAttribute("aria-selected", "true"));
      expect(screen.getByRole("button", { name: "Claim and create report" })).toBeEnabled();
      expect(mocks.getIncoming).toHaveBeenLastCalledWith(true);
      expect(mocks.routerPush).not.toHaveBeenCalled();
    });

    it("refuses without posting when the deadline changed after the button appeared", async () => {
      mocks.getIncoming.mockResolvedValue([sent]);
      mocks.getCapturePermission.mockResolvedValueOnce(allowed).mockResolvedValue({
        reopen: { allowed: false, reason: "LOTS_CLOSING_STARTED", reopenUntil: null },
      });
      renderIncoming();
      const panel = await openCompleted();
      fireEvent.click(await within(panel).findByRole("button", { name: "Re-Open" }));
      expect(await within(panel).findByRole("alert")).toHaveTextContent("lots have started closing");
      expect(mocks.reopenContractPart).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: `Review ${sent.contractNo}` })).toBeVisible();
    });

    it.each([
      ["EVENT_CLOSED", "event is closed or cancelled"],
      ["PROPOSAL_REVIEWED", "proposal has already been reviewed"],
      ["REVOKED", "assignment to this contract has been revoked"],
      ["NO_GRANT", "not currently assigned"],
      ["AMBIGUOUS_REOPEN_USER", "could not identify your contract assignment"],
    ])("shows useful refusal guidance for %s", async (code, message) => {
      mocks.getIncoming.mockResolvedValue([sent]);
      mocks.getCapturePermission.mockResolvedValue(allowed);
      mocks.reopenContractPart.mockRejectedValue({ response: { status: 409, data: { code, message: "http://127.0.0.1/internal Request failed with status code 409" } } });
      renderIncoming();
      const panel = await openCompleted();
      fireEvent.click(await within(panel).findByRole("button", { name: "Re-Open" }));
      expect(await within(panel).findByRole("alert")).toHaveTextContent(message);
      expect(within(panel).getByRole("alert")).not.toHaveTextContent(/409|127\.0\.0\.1/);
      expect(screen.getByRole("button", { name: `Review ${sent.contractNo}` })).toBeVisible();
    });

    it("offers explicit reconciliation of an uncertain prior request even after allowed becomes false", async () => {
      mocks.getIncoming.mockResolvedValue([sent]);
      mocks.getCapturePermission.mockResolvedValue({
        confirmationPending: true, reopen: { allowed: false, reason: null, reopenUntil: null },
      });
      mocks.reopenContractPart.mockResolvedValue({ ...reopened, reopened: false, alreadyOpen: true });
      renderIncoming();
      const panel = await openCompleted();
      const check = await within(panel).findByRole("button", { name: "Check Re-Open" });
      expect(mocks.reopenContractPart).not.toHaveBeenCalled();
      fireEvent.click(check);
      await waitFor(() => expect(mocks.reopenContractPart).toHaveBeenCalledExactlyOnceWith(sent.contractId));
      expect(await within(panel).findByRole("alert")).toHaveTextContent("Your part is open");
      expect(within(panel).getByRole("button", { name: "Refresh Incoming" })).toBeEnabled();
    });

    it("does not turn a pending check into a new reopen after its old intent is cleared", async () => {
      mocks.getIncoming.mockResolvedValue([sent]);
      mocks.getCapturePermission.mockResolvedValueOnce({
        confirmationPending: true, reopen: { allowed: false, reason: null, reopenUntil: null },
      }).mockResolvedValue(allowed);
      renderIncoming();
      const panel = await openCompleted();
      fireEvent.click(await within(panel).findByRole("button", { name: "Check Re-Open" }));
      expect(await within(panel).findByRole("alert")).toHaveTextContent("previous Re-Open request has already been checked");
      expect(mocks.reopenContractPart).not.toHaveBeenCalled();
      expect(await within(panel).findByRole("button", { name: "Re-Open" })).toBeEnabled();
    });

    it("keeps confirmed access after refresh fails and retries only the queue", async () => {
      mocks.getIncoming.mockResolvedValueOnce([sent]).mockRejectedValueOnce(new Error("http://localhost/private"))
        .mockResolvedValue([{ ...availableItem, contractId: sent.contractId, accessRevision: 2 }]);
      mocks.getCapturePermission.mockResolvedValue(allowed);
      mocks.reopenContractPart.mockResolvedValue(reopened);
      renderIncoming();
      const panel = await openCompleted();
      fireEvent.click(await within(panel).findByRole("button", { name: "Re-Open" }));
      expect(await within(panel).findByRole("alert")).toHaveTextContent("Your part is open, but Incoming could not refresh");
      fireEvent.click(within(panel).getByRole("button", { name: "Refresh Incoming" }));
      await waitFor(() => expect(screen.getByRole("tab", { name: /Outstanding/ })).toHaveAttribute("aria-selected", "true"));
      expect(mocks.reopenContractPart).toHaveBeenCalledTimes(1);
    });

    it("ignores a late success after the signed-in session changes", async () => {
      let finish!: (value: typeof reopened) => void;
      mocks.getIncoming.mockResolvedValue([sent]);
      mocks.getCapturePermission.mockResolvedValue(allowed);
      mocks.reopenContractPart.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      renderIncoming();
      const panel = await openCompleted();
      fireEvent.click(await within(panel).findByRole("button", { name: "Re-Open" }));
      await waitFor(() => expect(mocks.reopenContractPart).toHaveBeenCalledTimes(1));
      advanceAuthSession();
      await act(async () => finish(reopened));
      expect(mocks.getIncoming).toHaveBeenCalledTimes(1);
      expect(mocks.routerPush).not.toHaveBeenCalled();
    });

    it("cannot use a previous session's displayed button before React receives the account change", async () => {
      mocks.getIncoming.mockResolvedValue([sent]);
      mocks.getCapturePermission.mockResolvedValue(allowed);
      renderIncoming();
      const panel = await openCompleted();
      const button = await within(panel).findByRole("button", { name: "Re-Open" });
      advanceAuthSession();
      fireEvent.click(button);
      expect(mocks.getCapturePermission).toHaveBeenCalledTimes(1);
      expect(mocks.reopenContractPart).not.toHaveBeenCalled();
    });

    it("shows a safe retry when permission cannot be loaded", async () => {
      mocks.getIncoming.mockResolvedValue([sent]);
      mocks.getCapturePermission.mockRejectedValue(new Error("http://127.0.0.1/private status code 409"));
      renderIncoming();
      const panel = await openCompleted();
      expect(await within(panel).findByRole("status")).toHaveTextContent("Re-open availability could not be checked");
      expect(within(panel).queryByRole("button", { name: "Re-Open" })).toBeNull();
      mocks.getCapturePermission.mockResolvedValue(allowed);
      fireEvent.click(within(panel).getByRole("button", { name: "Check again" }));
      expect(await within(panel).findByRole("button", { name: "Re-Open" })).toBeEnabled();
    });

    it("hides previously cached permission until a new selection finishes checking", async () => {
      let finish!: (value: typeof allowed) => void;
      mocks.getIncoming.mockResolvedValue([sent]);
      mocks.getCapturePermission.mockResolvedValueOnce(allowed).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      renderIncoming();
      const panel = await openCompleted();
      await within(panel).findByRole("button", { name: "Re-Open" });
      fireEvent.click(within(panel).getByRole("button", { name: "Close contract details" }));
      await waitFor(() => expect(panel).toHaveAttribute("data-open", "false"));
      await selectContract(sent.contractNo);
      await waitFor(() => expect(mocks.getCapturePermission).toHaveBeenCalledTimes(2));
      expect(within(panel).queryByRole("button", { name: "Re-Open" })).toBeNull();
      await act(async () => finish(allowed));
      expect(await within(panel).findByRole("button", { name: "Re-Open" })).toBeEnabled();
    });
  });

  it("renders every proposal row returned by the incoming items contract", async () => {
    mocks.getIncoming.mockResolvedValue([
      {
        ...availableItem,
        cycleKey: "proposal:825291",
        contractId: "contract-825291",
        contractNo: "825291",
        eventTitle: "ProposalInAssetInsight",
        kind: "unknown",
        lotCount: 0,
      },
      {
        ...availableItem,
        cycleKey: "proposal:825295",
        contractId: "contract-825295",
        contractNo: "825295",
        eventTitle: "ProposalInAssetInsight",
        kind: "scheduleA",
      },
    ]);

    renderIncoming();

    expect(
      await screen.findByRole("button", { name: "Review 825291" })
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Review 825295" })
    ).toBeVisible();
    expect(screen.getAllByText("ProposalInAssetInsight")).toHaveLength(2);
    expect(mocks.getIncoming).toHaveBeenCalledWith();
  });

  it("shows description, customer, consignor and salesperson separately in the queue and selected contract", async () => {
    mocks.getIncoming.mockResolvedValue([{
      ...claimedItem,
      description: "Farm equipment",
      consignorName: "Northfield Consignor",
      salespersonName: "Sam Sales",
    }]);
    renderIncoming();

    const table = await screen.findByRole("table");
    const roles = [
      ["Description", "Farm equipment"],
      ["Customer", "Northfield Plant Ltd"],
      ["Consignor", "Northfield Consignor"],
      ["Salesperson", "Sam Sales"],
    ];
    for (const [role, name] of roles) {
      expect(within(table).getByRole("columnheader", { name: role })).toBeVisible();
      expect(within(table).getByRole("cell", { name })).toHaveAttribute("data-label", role);
    }

    const panel = await selectContract("CV-200");
    for (const [role, name] of roles) {
      const label = within(panel).getAllByRole("term").find((term) => term.textContent === role);
      expect(label?.nextElementSibling).toHaveTextContent(name);
    }
  });

  it("preserves a long description as plain text in the queue and selected contract", async () => {
    const description = `Equipment <img src=x onerror=alert(1)> ${"A".repeat(420)}`;
    mocks.getIncoming.mockResolvedValue([{ ...claimedItem, description }]);
    renderIncoming();

    const table = await screen.findByRole("table");
    const cell = table.querySelector('td[data-label="Description"]');
    expect(cell?.textContent).toBe(description);
    expect(cell).toHaveAttribute("title", description);
    expect(cell?.querySelector("img")).toBeNull();

    const panel = await selectContract("CV-200");
    const label = within(panel).getAllByRole("term").find((term) => term.textContent === "Description");
    expect(label?.nextElementSibling?.textContent).toBe(description);
    expect(label?.nextElementSibling?.querySelector("img")).toBeNull();
    expect(mocks.getIncoming).toHaveBeenCalledTimes(1);
    expect(mocks.getSetup).not.toHaveBeenCalled();
  });

  it("shows unavailable description and contact roles without borrowing other values", async () => {
    mocks.getIncoming.mockResolvedValue([claimedItem]);
    renderIncoming();

    const table = await screen.findByRole("table");
    for (const role of ["Description", "Consignor", "Salesperson"]) {
      expect(table.querySelector(`td[data-label="${role}"]`)).toHaveTextContent(/^Not supplied$/);
    }
    expect(within(table).getByRole("cell", { name: "Northfield Plant Ltd" })).toHaveAttribute("data-label", "Customer");

    const panel = await selectContract("CV-200");
    for (const role of ["Description", "Consignor", "Salesperson"]) {
      const label = within(panel).getAllByRole("term").find((term) => term.textContent === role);
      expect(label?.nextElementSibling).toHaveTextContent(/^Not supplied$/);
    }
    const customer = within(panel).getAllByRole("term").find((term) => term.textContent === "Customer");
    expect(customer?.nextElementSibling).toHaveTextContent("Northfield Plant Ltd");
  });

  it("drops the previous user's rows while the next user's queue loads", async () => {
    let resolveSecondUser!: (items: AuctioneerIncomingItem[]) => void;
    mocks.getIncoming
      .mockResolvedValueOnce([availableItem])
      .mockReturnValueOnce(
        new Promise<AuctioneerIncomingItem[]>((resolve) => {
          resolveSecondUser = resolve;
        })
      );

    const rendered = renderIncoming();
    expect(
      await screen.findByRole("button", { name: "Review CV-100" })
    ).toBeVisible();

    mocks.authUser = {
      _id: "user-2",
      email: "second@example.com",
      username: "Second User",
    };
    rendered.rerender(<IncomingHarness />);

    await waitFor(() => expect(mocks.getIncoming).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByRole("button", { name: "Review CV-100" })
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Loading incoming contracts/)).toBeInTheDocument();
    expect(
      mocks.getIncoming.mock.calls.every((args) => args.length === 0)
    ).toBe(true);

    await act(async () => {
      resolveSecondUser([]);
    });
    expect(await screen.findByText("No assigned lots")).toBeInTheDocument();
  });

  it.each([
    [
      { enabled: false, configured: true },
      "Incoming is currently disabled by your administrator.",
    ],
    [
      { enabled: true, configured: false },
      "Incoming needs an Auctioneer connection before contracts can be loaded.",
    ],
  ])(
    "explains an unavailable integration",
    async (status, message) => {
      mocks.getIncoming.mockResolvedValue([]);
      mocks.getStatus.mockResolvedValue(status);
      renderIncoming();

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.getByText("Incoming is not configured")).toBeInTheDocument();
    }
  );

  it("surfaces a reachable-status failure as an actionable error", async () => {
    mocks.getIncoming.mockRejectedValue(new Error("network down"));
    mocks.getStatus.mockResolvedValue({
      enabled: true,
      configured: true,
      reachable: false,
      message: "Auctioneer is temporarily offline.",
    });
    renderIncoming();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Auctioneer is temporarily offline."
    );
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  });

  it("selects a report type and claims an available contract", async () => {
    mocks.claim.mockResolvedValue(setupFor(availableItem, "lotListing"));
    renderIncoming();
    const panel = await selectContract("CV-100");

    const lotListing = within(panel).getByRole("radio", {
      name: /Lot listing/,
    });
    fireEvent.click(lotListing);
    expect(lotListing).toHaveAttribute("aria-checked", "true");
    fireEvent.click(
      within(panel).getByRole("button", {
        name: "Claim and create report",
      })
    );

    await waitFor(() =>
      expect(mocks.claim).toHaveBeenCalledWith("cycle-100", "lotListing")
    );
    await waitFor(() =>
      expect(mocks.routerPush).toHaveBeenCalledWith("/create/lot-listing")
    );
    expect(
      JSON.parse(
        window.sessionStorage.getItem("cv:report-form-handoff:v1") || "null"
      )
    ).toMatchObject({
      version: 1,
      kind: "lot-listing",
      returnTo: "/incoming",
      auctioneer: { reportType: "lotListing" },
    });
  });

  it("refreshes the queue and explains a claim conflict", async () => {
    mocks.claim.mockRejectedValue({
      response: { status: 409, data: { message: "already claimed" } },
    });
    renderIncoming();
    const panel = await selectContract("CV-100");

    fireEvent.click(
      within(panel).getByRole("button", {
        name: "Claim and create report",
      })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Another user claimed this contract first. The queue has been refreshed."
    );
    expect(mocks.getIncoming.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("resumes a work item already claimed by the current user", async () => {
    mocks.getIncoming.mockResolvedValue([claimedItem]);
    renderIncoming();
    const panel = await selectContract("CV-200");

    fireEvent.click(
      within(panel).getByRole("button", { name: "Resume report" })
    );

    await waitFor(() =>
      expect(mocks.getSetup).toHaveBeenCalledWith("work-claimed")
    );
    expect(mocks.routerPush).toHaveBeenCalledWith("/create/asset");
    expect(
      JSON.parse(
        window.sessionStorage.getItem("cv:report-form-handoff:v1") || "null"
      )
    ).toMatchObject({
      version: 1,
      kind: "asset",
      returnTo: "/incoming",
      auctioneer: { reportType: "asset" },
    });
  });

  it("releases a claimed work item and immediately refreshes", async () => {
    mocks.getIncoming.mockResolvedValue([claimedItem]);
    renderIncoming();
    const panel = await selectContract("CV-200");

    fireEvent.click(
      within(panel).getByRole("button", { name: "Release claim" })
    );

    await waitFor(() =>
      expect(mocks.releaseClaim).toHaveBeenCalledWith("work-claimed")
    );
    expect(mocks.getIncoming.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("opens an existing report rather than recreating it", async () => {
    /*
       The link NAMES the contract. It used to push the bare list, so the reader
       arrived at 36 rows with nothing selected and nothing opened — which the
       owner reported, reasonably, as the button not working (2026-09-29).
       My Reports seeds its search from ?contract= and picks the tab holding it.
    */
    mocks.getIncoming.mockResolvedValue([
      {
        ...claimedItem,
        status: "report_created",
      },
    ]);
    renderIncoming();
    const panel = await selectContract("CV-200");

    fireEvent.click(
      within(panel).getByRole("button", { name: "Open report" })
    );

    expect(mocks.routerPush).toHaveBeenCalledWith("/reports?search=CV-200");
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("falls back to the whole list when the contract has no number", async () => {
    /*
       A queue row can render as "Number unavailable". Linking to ?contract=
       with nothing after it would narrow My Reports to no rows at all, which is
       worse than showing everything.
    */
    mocks.getIncoming.mockResolvedValue([
      {
        ...claimedItem,
        contractNo: "",
        status: "report_created",
      },
    ]);
    renderIncoming();
    // The row DISPLAYS "Number unavailable", but its aria-label falls back to
    // "Review contract" — the label and the visible text differ here.
    const panel = await selectContract("contract");

    fireEvent.click(
      within(panel).getByRole("button", { name: "Open report" })
    );

    expect(mocks.routerPush).toHaveBeenCalledWith("/reports");
  });

  it("escapes a contract number that would otherwise break the link", async () => {
    // Contract numbers are free text upstream; one with & or # in it would
    // silently truncate the query string.
    mocks.getIncoming.mockResolvedValue([
      {
        ...claimedItem,
        contractNo: "CV/200 & 300",
        status: "report_created",
      },
    ]);
    renderIncoming();
    const panel = await selectContract("CV/200 & 300");

    fireEvent.click(
      within(panel).getByRole("button", { name: "Open report" })
    );

    expect(mocks.routerPush).toHaveBeenCalledWith(
      "/reports?search=CV%2F200%20%26%20300"
    );
  });
});
