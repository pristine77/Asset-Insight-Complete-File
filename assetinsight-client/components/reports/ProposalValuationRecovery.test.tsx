import { StrictMode } from "react";
import { advanceAuthSession } from "@/lib/auth-storage";
import { draftPointerKey } from "./proposal-valuation/draftRecovery";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  actorId: "pv-test-user",
}));

vi.mock("@/context/AuthContext", () => ({ useAuthContext: () => ({ user: { _id: mocks.actorId } }) }));

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
        auction_nmg_percent: null,
        cash_purchase_percent: null,
        capped_cash_purchase_percent: 1,
        capped_nmg_percent: 1,
        commission_basis_percent: 1,
        capped_threshold_percent: 0.1,
      },
    },
  };
}

type Change = { lotId: string | null; field: string; value: string | number | null };
type Request = { baseRevision: number; clientMutationId: string };

function accepted(changes: Change[], revision = 8): ProposalValuationPayload {
  const payload = makePayload();
  payload.revision = revision;
  for (const change of changes) {
    const row = payload.assetScheduleSheet.rows.find(item => item.lot_id === change.lotId);
    if (row && change.field.startsWith("evaluator_values.")) {
      row.evaluator_values[change.field.slice("evaluator_values.".length)] = change.value as number | null;
    }
  }
  return payload;
}
async function jayInput(): Promise<HTMLInputElement> {
  return (await screen.findAllByLabelText("Jay valuation for 13"))[0] as HTMLInputElement;
}
function startTyping(input: HTMLInputElement, raw: string) {
  fireEvent.doubleClick(input.closest("td")!);
  fireEvent.change(input, { target: { value: raw } });
}
function currentBackup(actor = mocks.actorId) {
  const pointer = sessionStorage.getItem(draftPointerKey(actor, "report-1"));
  return pointer ? JSON.parse(localStorage.getItem(pointer) || "null") : null;
}

describe("Proposal Valuation durable recovery", () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear(); advanceAuthSession();
    for (const mock of Object.values(mocks)) if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
    mocks.actorId = "pv-test-user"; mocks.mutationCounter = 0;
    mocks.get.mockResolvedValue(makePayload());
    mocks.patchChanges.mockImplementation(async (_report: string, changes: Change[]) => accepted(changes));
    mocks.evaluatorOptions.mockResolvedValue([]);
    mocks.streamEvents.mockImplementation(async (_report: string, _since: number, signal: AbortSignal) =>
      new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })));
  });

  it("keeps focused numeric text through reload and waits for explicit review", async () => {
    const view = render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    startTyping(await jayInput(), "47000");
    fireEvent(window, new Event("beforeunload"));
    expect(currentBackup().activeInput.raw).toBe("47000");
    view.unmount();
    render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    await screen.findByText(/Your unsaved browser draft was restored/);
    expect((await jayInput()).value).toContain("47,000");
    expect(mocks.patchChanges).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Resume saved draft" }));
    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(1));
    expect(mocks.patchChanges.mock.calls[0][1]).toEqual([{ lotId: "lot-13", field: "evaluator_values.jay", value: 47000 }]);
  });

  it("restores an unconfirmed save without replaying its old mutation identity", async () => {
    mocks.patchChanges.mockRejectedValueOnce(new Error("Connection lost after submission"));
    const view = render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    fireEvent.change(await jayInput(), { target: { value: "47000" } });
    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(1));
    const original = mocks.patchChanges.mock.calls[0][2] as Request;
    view.unmount();
    expect(currentBackup().retryEnvelope.request).toEqual(original);
    render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    await screen.findByText(/Your unsaved browser draft was restored/);
    expect(mocks.patchChanges).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Resume saved draft" }));
    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(2));
    expect(mocks.patchChanges.mock.calls[1][1]).toEqual(mocks.patchChanges.mock.calls[0][1]);
    expect(mocks.patchChanges.mock.calls[1][2].clientMutationId).not.toBe(original.clientMutationId);
  });

  it.each([true, false])("keeps same-cell conflicts across reload and requires a choice (keep mine: %s)", async keepMine => {
    const remote = makePayload(); remote.revision = 8;
    remote.assetScheduleSheet.rows[0].evaluator_values.jay = 45000;
    mocks.get.mockResolvedValueOnce(makePayload()).mockResolvedValue(remote);
    mocks.patchChanges.mockRejectedValueOnce(new ProposalValuationRevisionConflict("Changed remotely", 8));
    mocks.patchChanges.mockImplementationOnce(async (_report: string, changes: Change[]) => accepted(changes, 9));
    const view = render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    fireEvent.change(await jayInput(), { target: { value: "47000" } });
    await screen.findByText(/You and someone else both changed 1 cell/);
    expect(mocks.patchChanges).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    await screen.findByText(/You and someone else both changed 1 cell/);
    expect(mocks.patchChanges).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Resume saved draft" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resume saved draft" })).not.toBeInTheDocument());
    expect(mocks.patchChanges).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: keepMine ? "Keep mine" : "Keep saved" }));
    if (keepMine) {
      await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(2));
      expect(mocks.patchChanges.mock.calls[1][2].baseRevision).toBe(8);
      expect(mocks.patchChanges.mock.calls[1][1][0].value).toBe(47000);
    } else {
      expect((await jayInput()).value).toContain("45,000");
      expect(mocks.patchChanges).toHaveBeenCalledTimes(1);
    }
    expect(screen.queryByText(/You and someone else both changed/)).not.toBeInTheDocument();
  });

  it("Escape cancels only the newer edit while a previous save is in flight", async () => {
    let release!: (value: ProposalValuationPayload) => void;
    mocks.patchChanges.mockImplementationOnce(async () => new Promise<ProposalValuationPayload>(resolve => { release = resolve; }));
    render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    const input = await jayInput();
    fireEvent.change(input, { target: { value: "47000" } });
    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(1));
    startTyping(input, "48000"); fireEvent.keyDown(input, { key: "Escape" });
    await act(async () => release(accepted([{ lotId: "lot-13", field: "evaluator_values.jay", value: 47000 }])));
    await act(async () => new Promise(resolve => setTimeout(resolve, 650)));
    expect(mocks.patchChanges).toHaveBeenCalledTimes(1);
    expect((await jayInput()).value).toContain("47,000");
    expect(currentBackup().edits).toEqual([]);
  });

  it("Escape after a live refresh retains the previously committed pending value", async () => {
    let emit!: (event: { type: "ready"; reportId: string; revision: number }) => void;
    mocks.streamEvents.mockImplementation(async (_report, _since, signal: AbortSignal, callback) => {
      emit = callback;
      return new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const remote = makePayload(); remote.revision = 8; remote.assetScheduleSheet.rows[0].model = "Remote model";
    mocks.get.mockResolvedValueOnce(makePayload()).mockResolvedValue(remote);
    mocks.patchChanges.mockImplementation(async (_report: string, changes: Change[]) => accepted(changes, 9));
    render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    const input = await jayInput(); await waitFor(() => expect(emit).toBeDefined());
    fireEvent.change(input, { target: { value: "47000" } }); startTyping(input, "48000");
    await act(async () => emit({ type: "ready", reportId: "report-1", revision: 8 }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(1));
    expect(mocks.patchChanges.mock.calls[0][1]).toEqual([{ lotId: "lot-13", field: "evaluator_values.jay", value: 47000 }]);
  });

  it("does not mistake its own blank acknowledgement for a remote conflict", async () => {
    let release!: (value: ProposalValuationPayload) => void;
    mocks.patchChanges.mockImplementationOnce(async () => new Promise<ProposalValuationPayload>(resolve => { release = resolve; }));
    render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    const input = await jayInput(); fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(1));
    startTyping(input, "48000");
    await act(async () => release(accepted([{ lotId: "lot-13", field: "evaluator_values.jay", value: null }])));
    expect(screen.queryByText(/You and someone else both changed/)).not.toBeInTheDocument();
    expect(input.value).toBe("48000");
    expect(mocks.patchChanges).toHaveBeenCalledTimes(1);
  });

  it("preserves invalid unfinished text without saving its earlier partial number", async () => {
    const view = render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    const input = await jayInput(); startTyping(input, "47"); fireEvent.change(input, { target: { value: "-" } });
    view.unmount();
    expect(currentBackup().activeInput.raw).toBe("-"); expect(currentBackup().edits).toEqual([]);
    render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    await screen.findByText(/Your unsaved browser draft was restored/);
    fireEvent.click(screen.getByRole("button", { name: "Resume saved draft" }));
    expect(mocks.patchChanges).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("unfinished number"));
    fireEvent.click(screen.getByRole("button", { name: "Discard unfinished text" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume saved draft" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resume saved draft" })).not.toBeInTheDocument());
    expect((await jayInput()).value).toContain("42,000"); expect(mocks.patchChanges).not.toHaveBeenCalled();
  });

  it("ignores a delayed load from a different report", async () => {
    let release!: (value: ProposalValuationPayload) => void;
    const second = makePayload(); second.reportId = "report-2"; second.title = "Second report";
    mocks.get.mockImplementation((report: string) => report === "report-1"
      ? new Promise<ProposalValuationPayload>(resolve => { release = resolve; }) : Promise.resolve(second));
    const view = render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    view.rerender(<ProposalValuationDialog open reportId="report-2" pageMode />);
    await screen.findByText("Second report"); await act(async () => release(makePayload()));
    expect(screen.getByText("Second report")).toBeInTheDocument();
    expect(currentBackup()).toBeNull(); expect(mocks.patchChanges).not.toHaveBeenCalled();
  });

  it("does not let an old-session acknowledgement clear a recovered draft after account ABA", async () => {
    let release!: (value: ProposalValuationPayload) => void;
    mocks.patchChanges.mockImplementationOnce(async () => new Promise<ProposalValuationPayload>(resolve => { release = resolve; }));
    const view = render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    fireEvent.change(await jayInput(), { target: { value: "47000" } });
    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(1));
    mocks.actorId = "other-user"; advanceAuthSession(); view.rerender(<ProposalValuationDialog open reportId="report-1" pageMode />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect((await jayInput()).value).toContain("42,000");
    mocks.actorId = "pv-test-user"; advanceAuthSession(); view.rerender(<ProposalValuationDialog open reportId="report-1" pageMode />);
    await screen.findByText(/Your unsaved browser draft was restored/);
    await act(async () => release(accepted([{ lotId: "lot-13", field: "evaluator_values.jay", value: 47000 }])));
    expect(screen.getByRole("button", { name: "Resume saved draft" })).toBeInTheDocument();
    expect((await jayInput()).value).toContain("47,000"); expect(mocks.patchChanges).toHaveBeenCalledTimes(1);
    fireEvent(window, new Event("beforeunload"));
    expect(currentBackup().edits[0].value).toBe(47000);
  });

  it("continues autosaving after StrictMode effect replay and preserves explicit zero", async () => {
    render(<StrictMode><ProposalValuationDialog open reportId="report-1" pageMode /></StrictMode>);
    fireEvent.change(await jayInput(), { target: { value: "0" } });
    await waitFor(() => expect(mocks.patchChanges).toHaveBeenCalledTimes(1));
    expect(mocks.patchChanges.mock.calls[0][1]).toEqual([{ lotId: "lot-13", field: "evaluator_values.jay", value: 0 }]);
    expect((await jayInput()).value).toContain("0");
  });
  it("keeps a focused entry locally when permissions disappear before blur", async () => {
    let emit!: (event: { type: "ready"; reportId: string; revision: number }) => void;
    mocks.streamEvents.mockImplementation(async (_report, _since, signal: AbortSignal, callback) => {
      emit = callback;
      return new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const readonly = makePayload(); readonly.revision = 8;
    readonly.permissions = { canEditAll: false, canManageEvaluators: false, canRegenerateFiles: false, evaluatorColumnId: null };
    mocks.get.mockResolvedValueOnce(makePayload()).mockResolvedValue(readonly);
    render(<ProposalValuationDialog open reportId="report-1" pageMode />);
    const input = await jayInput(); await waitFor(() => expect(emit).toBeDefined());
    startTyping(input, "47000");
    await act(async () => emit({ type: "ready", reportId: "report-1", revision: 8 }));
    await waitFor(() => expect(input).toBeDisabled());
    fireEvent.blur(input, { relatedTarget: null });
    fireEvent(window, new Event("beforeunload"));
    expect(mocks.patchChanges).not.toHaveBeenCalled();
    expect(currentBackup().activeInput.raw).toBe("47000");
    expect(currentBackup().dropped.some((entry: Change) => entry.field === "evaluator_values.jay" && entry.value === 47000)).toBe(true);
  });

 it("discards active recovery from a field that became read-only",async()=>{
  localStorage.clear();sessionStorage.clear();mocks.actorId="pv-test-user";mocks.mutationCounter=0;
  let emit!: (event: {type:"ready";reportId:string;revision:number})=>void;
  mocks.streamEvents.mockImplementation(async(_r,_s,signal:AbortSignal,callback)=>{emit=callback;return new Promise<void>(r=>signal.addEventListener("abort",()=>r(),{once:true}));});
  mocks.evaluatorOptions.mockResolvedValue([]);mocks.patchChanges.mockResolvedValue(makePayload());
  const remote=makePayload();remote.revision=8;remote.permissions={canEditAll:false,canManageEvaluators:false,canRegenerateFiles:false,evaluatorColumnId:null};
  mocks.get.mockResolvedValueOnce(makePayload()).mockResolvedValue(remote);
  vi.spyOn(window,"confirm").mockReturnValue(true);
  const view=render(<ProposalValuationDialog open reportId="report-1" pageMode/>);
  const input=await jayInput();await waitFor(()=>expect(emit).toBeDefined());startTyping(input,"47000");
  await act(async()=>emit({type:"ready",reportId:"report-1",revision:8}));
  const discard=await screen.findByRole("button",{name:"Discard removed entries"});
  fireEvent.click(discard);view.unmount();
  const backup=currentBackup();
  expect(backup.edits).toEqual([]);expect(backup.dropped).toEqual([]);expect(backup.activeInput).toBeNull();
 });
 it("retains the latest edit made while the Resume GET is pending",async()=>{
  localStorage.clear();sessionStorage.clear();mocks.actorId="pv-test-user";mocks.mutationCounter=0;
  mocks.streamEvents.mockImplementation(async(_r,_s,signal:AbortSignal)=>new Promise<void>(r=>signal.addEventListener("abort",()=>r(),{once:true})));
  mocks.evaluatorOptions.mockResolvedValue([]);
  mocks.patchChanges.mockRejectedValueOnce(new Error("unconfirmed"));
  mocks.patchChanges.mockImplementation(async(_r:string,changes:Change[])=>accepted(changes));
  let release!: (value:ProposalValuationPayload)=>void;
  mocks.get.mockResolvedValueOnce(makePayload()).mockResolvedValueOnce(makePayload()).mockImplementationOnce(()=>new Promise<ProposalValuationPayload>(r=>{release=r}));
  const view=render(<ProposalValuationDialog open reportId="report-1" pageMode/>);
  fireEvent.change(await jayInput(),{target:{value:"47000"}});
  await waitFor(()=>expect(mocks.patchChanges).toHaveBeenCalledTimes(1));view.unmount();
  render(<ProposalValuationDialog open reportId="report-1" pageMode/>);
  await screen.findByRole("button",{name:"Resume saved draft"});
  fireEvent.click(screen.getByRole("button",{name:"Resume saved draft"}));
  await waitFor(()=>expect(release).toBeDefined());
  const input=await jayInput();startTyping(input,"42000");fireEvent.keyDown(input,{key:"Enter"});
  await act(async()=>release(makePayload()));
  await waitFor(()=>expect(mocks.patchChanges).toHaveBeenCalledTimes(2));
  
  expect(mocks.patchChanges.mock.calls[1][1]).toEqual([{lotId:"lot-13",field:"evaluator_values.jay",value:42000}]);
 });
});
