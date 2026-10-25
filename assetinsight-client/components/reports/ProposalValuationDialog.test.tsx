import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProposalValuationAccessLost,
  ProposalValuationRevisionConflict,
} from "@/services/proposalValuation";
import type { ProposalValuationPayload } from "./proposal-valuation/types";
import ProposalValuationDialog from "./ProposalValuationDialog";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patchChanges: vi.fn(),
  updateEvaluators: vi.fn(),
  evaluatorOptions: vi.fn(),
  exportExcel: vi.fn(),
  regenerate: vi.fn(),
  streamEvents: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  mutationCounter: 0,
}));

vi.mock("@/services/proposalValuation", () => ({
  ProposalValuationAccessLost: class ProposalValuationAccessLost extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  ProposalValuationRevisionConflict: class ProposalValuationRevisionConflict extends Error {
    currentRevision: number;
    constructor(message: string, currentRevision: number) {
      super(message);
      this.currentRevision = currentRevision;
    }
  },
  ProposalValuationStreamAuthenticationError: class ProposalValuationStreamAuthenticationError extends Error {},
  ProposalValuationService: {
    get: mocks.get,
    patchChanges: mocks.patchChanges,
    updateEvaluators: mocks.updateEvaluators,
    evaluatorOptions: mocks.evaluatorOptions,
    exportExcel: mocks.exportExcel,
    regenerate: mocks.regenerate,
    streamEvents: mocks.streamEvents,
    newMutationId: vi.fn(() => `mutation-${++mocks.mutationCounter}`),
  },
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

function makePayload(): ProposalValuationPayload {
  return {
    reportId: "report-1",
    title: "McDougall Auctioneering Inc.",
    currencyCode: "USD",
    revision: 7,
    permissions: {
      canManageEvaluators: true,
      canEditAll: true,
      evaluatorColumnId: null,
      canRegenerateFiles: true,
    },
    assetScheduleSheet: {
      evaluator_columns: [
        { id: "riley", name: "Riley" },
        { id: "jay", name: "Jay" },
        { id: "chad", name: "Chad" },
        { id: "femi", name: "Femi" },
      ],
      rows: [
        {
          lot_id: "lot-13",
          asset_id: "13",
          asset_category: "Light Duty Pickup Truck",
          year: "2023",
          make: "Ford",
          model: "F-150",
          serial_number: "1FTFW1E57LKE217",
          cr_details: "SuperCrew pickup with 4WD",
          condition_score: "4",
          location: "Regina, SK",
          pictures: 30,
          picture_urls: [
            "https://example.test/asset.jpg",
            "https://example.test/asset-rear.jpg",
          ],
          market_check: {
            comparable_count: "Moderate",
            avg_retail_asking_price: "Moderate",
            market_saturation: "Low",
            market_velocity: "Normal",
            regional_demand: "Strong",
            notes: "Stable regional demand",
          },
          asset_insight: "US$42,000",
          evaluator_values: {
            riley: 40000,
            jay: 42000,
            chad: 41000,
            femi: 43000,
          },
          low_est_sale_value: 40000,
          high_est_sale_value: 43000,
          buyer_premium_percent: 15,
          buyer_premium_amount: 2000,
          total_expected_gross: 45000,
          allocated_value: 45000,
          notes: "Original note",
          cleaning: 430,
          lien_search: 50,
          video_cost: 100,
          lotting_fee: 430,
          advertising: 430,
        },
      ],
      file_summary: {
        buyers_premium_basis: "uncapped",
        total_risk_weighted_value: 38000,
        file_risk_multiplier: 0.9,
        commission_percent_no_guarantee: 12,
        offer2_nmg_percent: 0.785,
        capped_threshold_percent: 0.1,
      },
    },
  };
}

function makeOwnerPayload(additionalCount = 3): ProposalValuationPayload {
  const payload = makePayload();
  payload.assetScheduleSheet.evaluator_columns = [
    { id: "retained-owner-column", name: "Report Creator", user_id: "report-owner", email: "owner@example.test" },
    ...payload.assetScheduleSheet.evaluator_columns.map((column, index) => ({
      ...column, ...(index < additionalCount ? { user_id: `evaluator-${index + 1}` } : {}),
    })),
  ];
  payload.assetScheduleSheet.rows[0].evaluator_values["retained-owner-column"] = 39000;
  payload.participants = [
    { id: "report-owner", email: "owner@example.test", isOwner: true, columnId: "retained-owner-column" },
    ...payload.assetScheduleSheet.evaluator_columns.filter(column => column.user_id && column.user_id !== "report-owner")
      .map(column => ({ id: column.user_id!, email: `${column.user_id}@example.test`, isOwner: false, columnId: column.id })),
  ];
  return payload;
}

describe("ProposalValuationDialog", () => {
  beforeEach(() => {
    const payload = makePayload();
    mocks.get.mockReset();
    mocks.patchChanges.mockReset();
    mocks.updateEvaluators.mockReset();
    mocks.evaluatorOptions.mockReset();
    mocks.exportExcel.mockReset();
    mocks.regenerate.mockReset();
    mocks.streamEvents.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
    mocks.mutationCounter = 0;
    mocks.get.mockResolvedValue(payload);
    mocks.patchChanges.mockResolvedValue({ ...payload, revision: 8 });
    mocks.updateEvaluators.mockResolvedValue({ ...payload, revision: 8 });
    mocks.evaluatorOptions.mockResolvedValue([]);
    mocks.exportExcel.mockResolvedValue({
      blob: new Blob(["workbook"]),
      filename: "proposal-valuation.xlsx",
    });
    mocks.regenerate.mockResolvedValue({ queued: true, coalesced: false, revision: 8 });
    mocks.streamEvents.mockImplementation(
      async (_reportId: string, _since: number, signal: AbortSignal) =>
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        })
    );
  });

  it("keeps all-lot column totals through pagination/search and recalculates edits including zero and blanks", async () => {
    const payload = makePayload();
    payload.assetScheduleSheet.evaluator_columns = [
      { id: "riley", name: "Riley" }, { id: "jay", name: "Jay" }, { id: "empty", name: "New appraiser" },
    ];
    payload.assetScheduleSheet.rows = Array.from({ length: 26 }, (_, index) => ({
      ...structuredClone(payload.assetScheduleSheet.rows[0]),
      lot_id: `lot-${index + 1}`,
      asset_id: `QA-${String(index + 1).padStart(3, "0")}`,
      evaluator_values: { riley: index === 25 ? 20000 : 1000, jay: index === 25 ? 30000 : 3000, empty: null },
    }));
    mocks.get.mockResolvedValue(payload);
    // Keep the test local: an unresolved draft save must not replace newer typed values.
    mocks.patchChanges.mockImplementation(() => new Promise(() => {}));
    const view = render(<ProposalValuationDialog open pageMode reportId="report-1" />);
    const footer = await screen.findByRole("rowgroup", { name: "All-lot valuation totals" });
    const expectTotals = (values: Record<string, string>) => {
      for (const [column, value] of Object.entries(values)) {
        expect(within(footer).getByLabelText(`${column} total for all lots`)).toHaveTextContent(value);
      }
    };
    const initialTotals = { Riley: "US$45,000", Jay: "US$105,000", "New appraiser": "US$0", Average: "US$75,000", Low: "US$45,000", High: "US$105,000", "Buyer premium": "US$9,500", "Total expected gross": "US$84,500.00", "Allocated value": "US$84,500.00", Cleaning: "US$1,050.00", "Lotting fee": "US$1,050.00", Advertising: "US$1,050.00" };
    expectTotals(initialTotals);
    expect(within(footer).getByText("All 26 lots")).toBeInTheDocument();
    expect(within(footer).getByLabelText("Buyer premium percentages are not summed")).toHaveTextContent("—");
    const mobileTotals = screen.getByRole("region", { name: "All-lot valuation totals" });
    expect(within(mobileTotals).getByRole("heading", { name: "Totals · All 26 lots" })).toBeInTheDocument();
    expect(within(mobileTotals).getByText("US$9,500.00")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Proposal valuation lots table" })).toHaveAttribute("tabindex", "0");

    fireEvent.click(screen.getByRole("button", { name: "Next assets page" }));
    expect(screen.getByText("26–26 of 26")).toBeInTheDocument();
    expectTotals(initialTotals);
    fireEvent.change(screen.getByPlaceholderText("Search assets"), { target: { value: "QA-026" } });
    await waitFor(() => expect(screen.getByText("1–1 of 1")).toBeInTheDocument());
    expectTotals(initialTotals);
    fireEvent.change(screen.getByPlaceholderText("Search assets"), { target: { value: "no matching asset" } });
    await screen.findByText("No assets match this search.");
    expectTotals(initialTotals);

    fireEvent.change(screen.getByPlaceholderText("Search assets"), { target: { value: "QA-001" } });
    const riley = (await screen.findAllByRole("spinbutton", { name: "Riley valuation for QA-001" }))[0];
    fireEvent.change(riley, { target: { value: "0" } });
    expectTotals({ ...initialTotals, Riley: "US$44,000", Average: "US$74,500", Low: "US$44,000", "Buyer premium": "US$9,425", "Total expected gross": "US$83,925.00", "Allocated value": "US$83,925.00" });
    fireEvent.change(screen.getAllByRole("spinbutton", { name: "Jay valuation for QA-001" })[0], { target: { value: "" } });
    expectTotals({ Riley: "US$44,000", Jay: "US$102,000", Average: "US$73,000", Low: "US$44,000", High: "US$102,000", "Buyer premium": "US$9,200", "Total expected gross": "US$82,200.00", "Allocated value": "US$82,200.00", Cleaning: "US$1,020.00", "Lotting fee": "US$1,020.00", Advertising: "US$1,020.00" });
    expect(within(mobileTotals).getByText("US$9,200.00")).toBeInTheDocument();
    expect(riley).toHaveValue(0);
    expect(screen.getAllByRole("spinbutton", { name: "Jay valuation for QA-001" })[0]).toHaveValue(null);
    view.unmount();
  });

  it("shows average-based premium and gross in live rows as well as the exact-cent footer", async () => {
    const payload = makePayload();
    payload.assetScheduleSheet.evaluator_columns = [{ id: "riley", name: "Riley" }, { id: "jay", name: "Jay" }];
    payload.assetScheduleSheet.rows[0].evaluator_values = { riley: 4000, jay: 4500 };
    // Saved derived fields intentionally still use the old high-based amounts.
    Object.assign(payload.assetScheduleSheet.rows[0], { buyer_premium_amount: 675, total_expected_gross: 5175, allocated_value: 5175 });
    mocks.get.mockResolvedValue(payload);
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);
    const footer = await screen.findByRole("rowgroup", { name: "All-lot valuation totals" });
    const table = within(screen.getByRole("region", { name: "Proposal valuation lots table" })).getByRole("table");
    const row = table.querySelector("tbody tr")!;
    for (const [label, text] of Object.entries({ "Buyer Premium ($)": "US$638", "Total Expected Gross ($)": "US$4,888", "Allocated Value ($)": "US$4,888" })) {
      const header = within(table).getByRole("columnheader", { name: label });
      const index = Array.from(header.parentElement!.children).indexOf(header);
      expect(row.children[index]).toHaveTextContent(text);
    }
    expect(within(footer).getByLabelText("Buyer premium total for all lots")).toHaveTextContent("US$637.50");
    expect(within(footer).getByLabelText("Total expected gross total for all lots")).toHaveTextContent("US$4,887.50");
  });

  it("keeps an explicitly scoped zero totals row and mobile summary for an empty sheet", async () => {
    const payload = makePayload();
    payload.assetScheduleSheet.rows = [];
    mocks.get.mockResolvedValue(payload);
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);
    const footer = await screen.findByRole("rowgroup", { name: "All-lot valuation totals" });
    expect(within(footer).getByText("All 0 lots")).toBeInTheDocument();
    for (const column of ["Riley", "Jay", "Chad", "Femi", "Average", "Low", "High", "Buyer premium", "Total expected gross", "Allocated value", "Cleaning", "Lien search", "Video cost", "Lotting fee", "Advertising"]) {
      expect(within(footer).getByLabelText(`${column} total for all lots`)).toHaveTextContent("US$0");
    }
    expect(within(screen.getByRole("region", { name: "All-lot valuation totals" })).getByRole("heading", { name: "Totals · All 0 lots" })).toBeInTheDocument();
  });

  it("shows the complete Schedule A field set and every saved evaluator", async () => {
    render(
      <ProposalValuationDialog
        open
        pageMode
        reportId="report-1"
        onClose={vi.fn()}
      />
    );

    for (const header of [
      "Asset ID",
      "Asset Category",
      "Year",
      "Make",
      "Model",
      "Serial Number",
      "CR Details",
      "Condition (1-5)",
      "Location (City, State/Prov)",
      "Pictures",
      "Asset Insight",
      "Average",
      "Low Est. Sale Value ($)",
      "High Est. Sale Value ($)",
      "Buyer Premium %",
      "Buyer Premium ($)",
      "Total Expected Gross ($)",
      "Allocated Value ($)",
      "Notes",
      "Cleaning",
      "Lien Search",
      "Video Cost",
      "Lotting Fee",
      "Advertising",
    ]) {
      expect(await screen.findByRole("columnheader", { name: header })).toBeInTheDocument();
    }

    for (const evaluator of ["Riley", "Jay", "Chad", "Femi"]) {
      expect(screen.getByRole("columnheader", { name: evaluator })).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", {
        name: "Export McDougall Auctioneering Inc. to Excel",
      })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "File summary" }));
    expect(screen.getByRole("spinbutton", { name: "Total risk-weighted value" })).toHaveValue(38000);
    expect(screen.getByRole("spinbutton", { name: "File risk multiplier" })).toHaveValue(0.9);
    expect(
      screen.getAllByTitle("Reference only; not used in calculated totals.")
    ).toHaveLength(3);
  });

  it("opens the user picture gallery from the shared Schedule A row", async () => {
    render(
      <ProposalValuationDialog
        open
        pageMode
        reportId="report-1"
        onClose={vi.fn()}
      />
    );

    const pictureButtons = await screen.findAllByRole("button", {
      name: "Open 2 pictures for 13",
    });
    pictureButtons[0].focus();
    fireEvent.click(pictureButtons[0]);

    expect(
      screen.getByRole("dialog", { name: "Pictures for 13" })
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "13 picture 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close picture gallery" })).toHaveFocus();

    const next = screen.getByRole("button", { name: "Next picture" });
    next.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close picture gallery" })).toHaveFocus();

    screen.getByRole("button", { name: "Close picture gallery" }).focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(next).toHaveFocus();

    fireEvent.click(next);
    expect(screen.getByRole("img", { name: "13 picture 2" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Pictures for 13" })
      ).not.toBeInTheDocument();
      expect(pictureButtons[0]).toHaveFocus();
    });
  });

  it("updates the range and projected costs while evaluator values change", async () => {
    render(
      <ProposalValuationDialog
        open
        pageMode
        reportId="report-1"
        onClose={vi.fn()}
      />
    );

    expect(
      (await screen.findAllByText("US$40,000 - US$43,000")).length
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("US$1,440").length).toBeGreaterThan(0);

    const femiFields = screen.getAllByLabelText("Femi valuation for 13");
    fireEvent.change(femiFields[0], { target: { value: "50000" } });

    await waitFor(() => {
      expect(screen.getAllByText("US$40,000 - US$50,000").length).toBeGreaterThan(0);
      expect(screen.getAllByText("US$1,650").length).toBeGreaterThan(0);
    });
  });

  it("autosaves edited fields as narrow revisioned changes", async () => {
    render(
      <ProposalValuationDialog
        open
        pageMode
        reportId="report-1"
        onClose={vi.fn()}
      />
    );

    const categoryFields = await screen.findAllByLabelText("Asset category for 13");
    const notesFields = screen.getAllByLabelText("Notes for 13");
    const lienFields = screen.getAllByLabelText("Lien search cost for 13");

    fireEvent.change(categoryFields[0], { target: { value: "Emergency Vehicles" } });
    fireEvent.change(notesFields[0], { target: { value: "User-reviewed note" } });
    fireEvent.change(lienFields[0], { target: { value: "75" } });

    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(1), {
      timeout: 1500,
    });
    expect(mocks.patchChanges).toHaveBeenCalledWith(
      "report-1",
      expect.arrayContaining([
        { lotId: "lot-13", field: "asset_category", value: "Emergency Vehicles" },
        { lotId: "lot-13", field: "notes", value: "User-reviewed note" },
        { lotId: "lot-13", field: "lien_search", value: 75 },
      ]),
      { baseRevision: 7, clientMutationId: "mutation-1" }
    );
  });

  it("lets an invited evaluator edit only their linked column", async () => {
    const payload = makePayload();
    payload.permissions = {
      canManageEvaluators: false,
      canEditAll: false,
      evaluatorColumnId: "femi",
      canRegenerateFiles: false,
    };
    mocks.get.mockResolvedValue(payload);

    render(<ProposalValuationDialog open pageMode reportId="report-1" />);

    const categoryFields = await screen.findAllByLabelText("Asset category for 13");
    const rileyFields = screen.getAllByLabelText("Riley valuation for 13");
    const femiFields = screen.getAllByLabelText("Femi valuation for 13");
    expect(categoryFields.every((field) => field.hasAttribute("disabled"))).toBe(true);
    expect(rileyFields.every((field) => field.hasAttribute("disabled"))).toBe(true);
    expect(femiFields.every((field) => !field.hasAttribute("disabled"))).toBe(true);
    expect(screen.queryByRole("button", { name: "Update report files" })).not.toBeInTheDocument();
  });

  it("assigns evaluator accounts from the searchable dropdown", async () => {
    mocks.evaluatorOptions.mockResolvedValue([
      {
        id: "user-2",
        username: "Alex Morgan",
        companyName: "Prairie Appraisals",
        email: "alex@example.test",
      },
    ]);
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Add evaluator" }));
    fireEvent.change(screen.getByPlaceholderText("Search users by name or email"), {
      target: { value: "Alex" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /Alex Morgan/i }));

    await waitFor(() =>
      expect(mocks.updateEvaluators).toHaveBeenCalledWith(
        "report-1",
        ["user-2"],
        { baseRevision: 7, clientMutationId: "mutation-1" }
      )
    );
  });

  it("keeps the report owner fixed while adding the fourth additional evaluator and retaining legacy columns", async () => {
    const payload = makeOwnerPayload();
    mocks.get.mockResolvedValue(payload);
    mocks.updateEvaluators.mockResolvedValue({ ...payload, revision: 8 });
    mocks.evaluatorOptions.mockResolvedValue([
      { id: "report-owner", username: "Report Creator", email: "owner@example.test" },
      { id: "evaluator-4", username: "Fourth Evaluator", email: "fourth@example.test" },
    ]);
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);
    expect(await screen.findByText("Report owner")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Report Creator" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Femi" })).toBeInTheDocument();
    expect(screen.getByText("legacy")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Report Creator valuation for 13").every(field => !field.hasAttribute("disabled"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add evaluator" }));
    expect(await screen.findByRole("option", { name: /Fourth Evaluator/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Report Creator/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Fourth Evaluator/ }));
    await waitFor(() => expect(mocks.updateEvaluators).toHaveBeenCalledWith("report-1",
      ["evaluator-1", "evaluator-2", "evaluator-3", "evaluator-4"],
      { baseRevision: 7, clientMutationId: "mutation-1" }));
    expect(screen.getByRole("columnheader", { name: "Report Creator" })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Report Creator valuation for 13")[0]).toHaveValue(39000);
  });

  it("removes only an additional evaluator and never sends the intrinsic owner as an assignment", async () => {
    const payload = makeOwnerPayload();
    mocks.get.mockResolvedValue(payload);
    mocks.updateEvaluators.mockResolvedValue({ ...payload, revision: 8 });
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Jay" }));
    await waitFor(() => expect(mocks.updateEvaluators).toHaveBeenCalledWith("report-1",
      ["evaluator-1", "evaluator-3"], { baseRevision: 7, clientMutationId: "mutation-1" }));
    expect(screen.queryByRole("button", { name: "Remove Report Creator" })).not.toBeInTheDocument();
  });

  it("limits four additional accounts independently from the fixed owner", async () => {
    mocks.get.mockResolvedValue(makeOwnerPayload(4));
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);
    expect(await screen.findByRole("button", { name: "4 additional evaluators added" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: /^Remove (Riley|Jay|Chad|Femi)$/ })).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Remove Report Creator" })).not.toBeInTheDocument();
  });

  it("does not grant an invited evaluator access to the report owner's value column", async () => {
    const payload = makeOwnerPayload();
    payload.permissions = { canManageEvaluators: false, canEditAll: false, evaluatorColumnId: "jay", canRegenerateFiles: false };
    mocks.get.mockResolvedValue(payload);
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);
    await screen.findByText("Report owner");
    expect(screen.getAllByLabelText("Report Creator valuation for 13").every(field => field.hasAttribute("disabled"))).toBe(true);
    expect(screen.getAllByLabelText("Jay valuation for 13").every(field => !field.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("button", { name: "Add evaluator" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Update report files" })).not.toBeInTheDocument();
  });

  it("keeps evaluator assignment disabled while a draft retry is unresolved", async () => {
    mocks.patchChanges.mockRejectedValue(
      new Error("connection reset after the draft may have committed")
    );
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);

    const notes = await screen.findAllByLabelText("Notes for 13");
    fireEvent.change(notes[0], { target: { value: "Retain this local draft" } });

    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(1), {
      timeout: 1500,
    });
    const addEvaluator = screen.getByRole("button", { name: "Add evaluator" });
    expect(addEvaluator).toBeDisabled();
    fireEvent.click(addEvaluator);
    expect(mocks.updateEvaluators).not.toHaveBeenCalled();
    expect(screen.getByText("Draft queued")).toBeInTheDocument();

    // Let this component's scheduled retry settle before the next test resets
    // the shared service mock. Otherwise the intentional unmount flush can be
    // observed as the next test's first mutation.
    const recovered = makePayload();
    recovered.revision = 8;
    recovered.assetScheduleSheet.rows[0].notes = "Retain this local draft";
    mocks.patchChanges.mockResolvedValue(recovered);
    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    });
  });

  it("does not let a delayed evaluator response regress a newer live revision", async () => {
    let emit:
      | ((event: {
          type: "pv-revision";
          reportId: string;
          revision: number;
        }) => void)
      | undefined;
    let resolveAssignment:
      | ((payload: ProposalValuationPayload) => void)
      | undefined;
    const remote = makePayload();
    remote.revision = 9;
    remote.title = "Newest evaluator workspace";
    const stale = makePayload();
    stale.revision = 8;
    stale.title = "Stale evaluator response";
    mocks.get.mockReset().mockResolvedValueOnce(makePayload()).mockResolvedValue(remote);
    mocks.evaluatorOptions.mockResolvedValue([
      {
        id: "user-2",
        username: "Alex Morgan",
        companyName: "Prairie Appraisals",
        email: "alex@example.test",
      },
    ]);
    mocks.updateEvaluators.mockReturnValueOnce(
      new Promise<ProposalValuationPayload>((resolve) => {
        resolveAssignment = resolve;
      })
    );
    mocks.streamEvents.mockImplementation(
      async (
        _reportId: string,
        _since: number,
        signal: AbortSignal,
        onEvent: typeof emit
      ) => {
        emit = onEvent;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    );
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);
    await waitFor(() => expect(emit).toBeTypeOf("function"));

    fireEvent.click(screen.getByRole("button", { name: "Add evaluator" }));
    fireEvent.click(await screen.findByRole("option", { name: /Alex Morgan/i }));
    await waitFor(() => expect(mocks.updateEvaluators).toHaveBeenCalledTimes(1));

    act(() => {
      emit?.({ type: "pv-revision", reportId: "report-1", revision: 9 });
    });
    expect(await screen.findByText("Newest evaluator workspace")).toBeInTheDocument();

    act(() => resolveAssignment?.(stale));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(screen.queryByText("Stale evaluator response")).not.toBeInTheDocument();
    expect(screen.getByText("Newest evaluator workspace")).toBeInTheDocument();
    expect(screen.getByText("Saved · revision 9")).toBeInTheDocument();
  });

  it("opens accessible formula details for calculated final values", async () => {
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "File summary" }));
    fireEvent.click(
      screen.getByRole("button", { name: "How Total Asset Value is calculated" })
    );

    const dialog = screen.getByRole("dialog", { name: "Total asset value" });
    expect(dialog).toHaveTextContent("Sum of each lot's evaluator average");
    expect(dialog).toHaveTextContent("US$41,500");
    expect(screen.getByRole("button", { name: "Close calculation details" })).toHaveFocus();
  });

  it("paginates filtered assets in 25, 50, or 100 row pages", async () => {
    const payload = makePayload();
    const source = payload.assetScheduleSheet.rows[0];
    payload.assetScheduleSheet.rows = Array.from({ length: 26 }, (_, index) => ({
      ...structuredClone(source),
      lot_id: `lot-${index + 1}`,
      asset_id: String(index + 1),
    }));
    mocks.get.mockResolvedValue(payload);
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);

    expect(await screen.findByText("1–25 of 26")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next assets page" }));
    expect(await screen.findByText("26–26 of 26")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Rows per page" })).toHaveValue("25");
  });

  it("refetches, rebases, and retries one pending draft after a revision conflict", async () => {
    const initial = makePayload();
    const remote = { ...makePayload(), revision: 8 };
    const accepted = makePayload();
    accepted.revision = 9;
    accepted.assetScheduleSheet.rows[0].notes = "Locally rebased note";
    mocks.get
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(remote);
    mocks.patchChanges
      .mockReset()
      .mockRejectedValueOnce(
        new ProposalValuationRevisionConflict("Changed remotely", 8)
      )
      .mockResolvedValueOnce(accepted);

    render(<ProposalValuationDialog open pageMode reportId="report-1" />);
    const notes = await screen.findAllByLabelText("Notes for 13");
    fireEvent.change(notes[0], { target: { value: "Locally rebased note" } });

    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(2), {
      timeout: 2500,
    });
    expect(mocks.patchChanges.mock.calls[0][2]).toMatchObject({ baseRevision: 7 });
    expect(mocks.patchChanges.mock.calls[1]).toEqual([
      "report-1",
      [{ lotId: "lot-13", field: "notes", value: "Locally rebased note" }],
      { baseRevision: 8, clientMutationId: "mutation-2" },
    ]);
  });

  it("resyncs when the live stream reports a newer ready revision", async () => {
    mocks.streamEvents.mockImplementation(
      async (
        _reportId: string,
        _since: number,
        signal: AbortSignal,
        onEvent: (event: { type: "ready"; reportId: string; revision: number }) => void
      ) => {
        await Promise.resolve();
        onEvent({ type: "ready", reportId: "report-1", revision: 8 });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    );
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);

    await screen.findByText("McDougall Auctioneering Inc.");
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(mocks.streamEvents).toHaveBeenCalledWith(
      "report-1",
      7,
      expect.any(AbortSignal),
      expect.any(Function)
    );
  });

  it("stops autosave and retains the visible draft when evaluator access is removed", async () => {
    mocks.patchChanges.mockRejectedValue(
      new ProposalValuationAccessLost(
        "Your evaluator access to this Proposal Valuation was removed.",
        404
      )
    );
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);

    const notes = await screen.findAllByLabelText("Notes for 13");
    fireEvent.change(notes[0], { target: { value: "Keep this unsaved draft" } });

    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(1), {
      timeout: 1500,
    });
    expect(
      await screen.findByText("Proposal Valuation access ended")
    ).toBeInTheDocument();
    expect(screen.getByText(/current draft remains visible/i)).toBeInTheDocument();
    expect(
      screen.getAllByLabelText("Notes for 13").every((field) =>
        field.hasAttribute("disabled") &&
        (field as HTMLTextAreaElement).value === "Keep this unsaved draft"
      )
    ).toBe(true);
    await new Promise((resolve) => window.setTimeout(resolve, 750));
    expect(mocks.patchChanges).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("treats an access-changed resync event as terminal without refetching", async () => {
    mocks.streamEvents.mockImplementation(
      async (
        _reportId: string,
        _since: number,
        signal: AbortSignal,
        onEvent: (event: {
          type: "resync";
          reportId: string;
          reason: string;
        }) => void
      ) => {
        onEvent({
          type: "resync",
          reportId: "report-1",
          reason: "access-changed",
        });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    );
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);

    expect(
      await screen.findByText("Proposal Valuation access ended")
    ).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.streamEvents).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("serializes live resyncs and refuses to apply an older revision last", async () => {
    let emit:
      | ((event: {
          type: "pv-revision";
          reportId: string;
          revision: number;
        }) => void)
      | undefined;
    const newest = makePayload();
    newest.revision = 9;
    newest.title = "Newest collaborative revision";
    const stale = makePayload();
    stale.revision = 8;
    stale.title = "Stale collaborative revision";
    mocks.get
      .mockReset()
      .mockResolvedValueOnce(makePayload())
      .mockResolvedValueOnce(newest)
      .mockResolvedValueOnce(stale);
    mocks.streamEvents.mockImplementation(
      async (
        _reportId: string,
        _since: number,
        signal: AbortSignal,
        onEvent: typeof emit
      ) => {
        emit = onEvent;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    );
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);
    await waitFor(() => expect(emit).toBeTypeOf("function"));

    act(() => {
      emit?.({ type: "pv-revision", reportId: "report-1", revision: 8 });
      emit?.({ type: "pv-revision", reportId: "report-1", revision: 9 });
    });

    expect(await screen.findByText("Newest collaborative revision")).toBeInTheDocument();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("Stale collaborative revision")).not.toBeInTheDocument();
    expect(screen.getByText("Saved · revision 9")).toBeInTheDocument();
  });

  it("keeps the workspace and pending draft visible when live refresh fails", async () => {
    let emit:
      | ((event: {
          type: "pv-revision";
          reportId: string;
          revision: number;
        }) => void)
      | undefined;
    const remote = makePayload();
    remote.revision = 9;
    remote.title = "Recovered collaborative workspace";
    mocks.get
      .mockReset()
      .mockResolvedValueOnce(makePayload())
      .mockRejectedValueOnce(new Error("temporary refresh outage"));
    mocks.patchChanges
      .mockReset()
      .mockRejectedValueOnce(new Error("draft response was lost"));
    mocks.streamEvents.mockImplementation(
      async (
        _reportId: string,
        _since: number,
        signal: AbortSignal,
        onEvent: typeof emit
      ) => {
        emit = onEvent;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    );
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);
    await waitFor(() => expect(emit).toBeTypeOf("function"));
    const notes = await screen.findAllByLabelText("Notes for 13");
    fireEvent.change(notes[0], { target: { value: "Draft that must survive" } });
    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(1), {
      timeout: 1500,
    });

    act(() => {
      emit?.({ type: "pv-revision", reportId: "report-1", revision: 8 });
    });
    const refreshNotice = await screen.findByRole("status");
    expect(refreshNotice).toHaveTextContent("temporary refresh outage");
    expect(screen.getByText("McDougall Auctioneering Inc.")).toBeInTheDocument();
    expect(
      screen.getAllByLabelText("Notes for 13").every(
        (field) => (field as HTMLTextAreaElement).value === "Draft that must survive"
      )
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: /^Retry$/ })
    ).not.toBeInTheDocument();

    mocks.get.mockResolvedValue(remote);
    fireEvent.click(screen.getByRole("button", { name: "Retry live refresh" }));
    expect(
      await screen.findByText("Recovered collaborative workspace")
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(
      screen.getAllByLabelText("Notes for 13").every(
        (field) => (field as HTMLTextAreaElement).value === "Draft that must survive"
      )
    ).toBe(true);
    expect(screen.getByText("Draft queued")).toBeInTheDocument();
  });

  it("retries an ambiguous lost response with the exact mutation envelope", async () => {
    const accepted = makePayload();
    accepted.revision = 8;
    accepted.assetScheduleSheet.rows[0].notes = "Idempotent note";
    mocks.patchChanges
      .mockReset()
      .mockRejectedValueOnce(new Error("connection reset after commit"))
      .mockResolvedValueOnce(accepted);
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);

    const notes = await screen.findAllByLabelText("Notes for 13");
    fireEvent.change(notes[0], { target: { value: "Idempotent note" } });

    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    });
    expect(mocks.patchChanges.mock.calls[1]).toEqual(
      mocks.patchChanges.mock.calls[0]
    );
    expect(mocks.patchChanges.mock.calls[1][2]).toEqual({
      baseRevision: 7,
      clientMutationId: "mutation-1",
    });
  });

  it("drains a newer live revision that arrives while a local patch is in flight", async () => {
    let emit:
      | ((event: {
          type: "pv-revision";
          reportId: string;
          revision: number;
        }) => void)
      | undefined;
    let resolvePatch: ((payload: ProposalValuationPayload) => void) | undefined;
    const localResponse = makePayload();
    localResponse.revision = 8;
    localResponse.assetScheduleSheet.rows[0].notes = "Local note";
    const remoteResponse = makePayload();
    remoteResponse.revision = 9;
    remoteResponse.title = "Remote revision nine";
    remoteResponse.assetScheduleSheet.rows[0].notes = "Local note";
    mocks.get
      .mockReset()
      .mockResolvedValueOnce(makePayload())
      .mockResolvedValueOnce(remoteResponse);
    mocks.patchChanges.mockReset().mockReturnValueOnce(
      new Promise<ProposalValuationPayload>((resolve) => {
        resolvePatch = resolve;
      })
    );
    mocks.streamEvents.mockImplementation(
      async (
        _reportId: string,
        _since: number,
        signal: AbortSignal,
        onEvent: typeof emit
      ) => {
        emit = onEvent;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    );
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);
    await waitFor(() => expect(emit).toBeTypeOf("function"));
    const notes = await screen.findAllByLabelText("Notes for 13");
    fireEvent.change(notes[0], { target: { value: "Local note" } });
    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(1), {
      timeout: 1500,
    });

    act(() => {
      emit?.({ type: "pv-revision", reportId: "report-1", revision: 9 });
      resolvePatch?.(localResponse);
    });

    expect(await screen.findByText("Remote revision nine")).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Saved · revision 9")).toBeInTheDocument();
  });

  it("does not lower the live revision when file regeneration responds late", async () => {
    let emit:
      | ((event: {
          type: "pv-revision";
          reportId: string;
          revision: number;
        }) => void)
      | undefined;
    let resolveRegeneration:
      | ((response: {
          queued: boolean;
          coalesced: boolean;
          revision: number;
        }) => void)
      | undefined;
    const remote = makePayload();
    remote.revision = 9;
    remote.title = "Newest file workspace";
    mocks.get.mockReset().mockResolvedValueOnce(makePayload()).mockResolvedValue(remote);
    mocks.regenerate.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRegeneration = resolve;
      })
    );
    mocks.streamEvents.mockImplementation(
      async (
        _reportId: string,
        _since: number,
        signal: AbortSignal,
        onEvent: typeof emit
      ) => {
        emit = onEvent;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    );
    render(<ProposalValuationDialog open pageMode reportId="report-1" />);
    await waitFor(() => expect(emit).toBeTypeOf("function"));

    fireEvent.click(screen.getByRole("button", { name: "Update report files" }));
    await waitFor(() => expect(mocks.regenerate).toHaveBeenCalledTimes(1));
    act(() => {
      emit?.({ type: "pv-revision", reportId: "report-1", revision: 9 });
    });
    expect(await screen.findByText("Newest file workspace")).toBeInTheDocument();

    act(() =>
      resolveRegeneration?.({ queued: true, coalesced: false, revision: 8 })
    );
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(screen.getByText("Newest file workspace")).toBeInTheDocument();
    expect(screen.getByText("Saved · revision 9")).toBeInTheDocument();
  });
});
