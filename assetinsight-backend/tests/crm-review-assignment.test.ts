import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  agents: [] as any[],
  leads: [] as any[],
  prospects: [] as any[],
  userFind: vi.fn(),
  userUpdate: vi.fn(),
  cacheRead: vi.fn(),
  cacheWrite: vi.fn(),
  leadPopulate: vi.fn(),
  leadFind: vi.fn(),
  userSelect: vi.fn(),
}));

vi.mock("../src/models/user.model.js", () => ({
  default: {
    find: fixtures.userFind,
    updateOne: fixtures.userUpdate,
  },
}));
vi.mock("../src/models/crmGeoCache.model.js", () => ({
  default: {
    findOne: fixtures.cacheRead,
    findOneAndUpdate: fixtures.cacheWrite,
  },
}));
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));
vi.mock("../src/models/crmLead.model.js", () => ({
  default: {
    find: (filter: unknown) => {
      fixtures.leadFind(filter);
      const query = {
        select: () => query,
        populate: (...args: unknown[]) => { fixtures.leadPopulate(...args); return query; },
        sort: () => query,
        limit: () => query,
        lean: async () => fixtures.leads,
      };
      return query;
    },
  },
}));
vi.mock("../src/models/crmAutoFindLead.model.js", () => ({
  default: {
    find: () => {
      const query = {
        sort: () => query,
        limit: () => query,
        lean: async () => fixtures.prospects,
      };
      return query;
    },
  },
}));
vi.mock("../src/models/crmAutoFindRun.model.js", () => ({
  default: {
    find: () => {
      const query = {
        select: () => query,
        sort: () => query,
        limit: () => query,
        lean: async () => [],
      };
      return query;
    },
  },
}));
vi.mock("../src/service/crmAutoFindService.js", () => ({
  CANADA_PROVINCES: ["Ontario"],
  US_STATES: ["California"],
  CRM_AUTO_FIND_MAX_RESULTS: 100,
}));

import {
  chooseNearestCrmAssignee,
  prepareCrmAssignees,
  type CrmGeoLocation,
} from "../src/service/crmGeoAssignmentService.js";
import { getRevenueRadarSnapshot } from "../src/service/crmRevenueRadarService.js";

const emptyGeo: CrmGeoLocation = {
  sourceText: "", normalizedText: "", countryCode: "", regionCode: "",
  regionName: "", city: "", postalCode: "", confidence: 0, resolver: "empty",
};
const torontoGeo: CrmGeoLocation = {
  ...emptyGeo, sourceText: "Toronto, Ontario", normalizedText: "Toronto, Ontario",
  countryCode: "CA", regionCode: "ON", regionName: "Ontario", city: "Toronto",
  lat: 43.65, lng: -79.38, confidence: 1, resolver: "heuristic",
};

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.agents = [];
  fixtures.leads = [];
  fixtures.prospects = [];
  fixtures.userUpdate.mockResolvedValue({ acknowledged: true });
  fixtures.cacheWrite.mockResolvedValue({});
  fixtures.cacheRead.mockReturnValue({ lean: async () => ({ result: torontoGeo }) });
  fixtures.userFind.mockImplementation(() => {
    const query = {
      select: (...args: unknown[]) => { fixtures.userSelect(...args); return query; },
      sort: () => query,
      // Deliberately return contaminated candidates to exercise the runtime guard,
      // independently of the Mongo predicate asserted below.
      lean: async () => fixtures.agents,
    };
    return query;
  });
});

describe("production CRM geographic assignment review-account boundary", () => {
  it("excludes reviewers before geocoding or profile writes while retaining legacy agents", async () => {
    const legacy = { _id: "legacy", crmAddress: "" };
    const ordinary = { _id: "ordinary", isReviewAccount: false, crmAddress: "Toronto, Ontario" };
    const reviewer = { _id: "reviewer", isReviewAccount: true, crmAddress: "Toronto, Ontario" };
    const prepared = await prepareCrmAssignees([reviewer, legacy, ordinary]);

    expect(prepared.map(({ user }) => user._id)).toEqual(["legacy", "ordinary"]);
    expect(fixtures.cacheRead).toHaveBeenCalledTimes(1);
    expect(fixtures.userUpdate).toHaveBeenCalledTimes(1);
    expect(fixtures.userUpdate).toHaveBeenCalledWith({ _id: "ordinary" }, expect.anything());
  });

  it("makes an all-reviewer preparation empty without any provider or database work", async () => {
    expect(await prepareCrmAssignees([
      { _id: "reviewer", isReviewAccount: true, crmAddress: "Toronto, Ontario" },
    ])).toEqual([]);
    expect(fixtures.cacheRead).not.toHaveBeenCalled();
    expect(fixtures.cacheWrite).not.toHaveBeenCalled();
    expect(fixtures.userUpdate).not.toHaveBeenCalled();
  });

  it.each([emptyGeo, torontoGeo])("never chooses the reviewer with the best workload or location", (leadGeo) => {
    const result = chooseNearestCrmAssignee({
      leadGeo,
      leadSpecialization: "equipment",
      assignees: [
        { user: { _id: "reviewer", isReviewAccount: true, crmSpecializations: ["equipment"] }, geo: torontoGeo },
        { user: { _id: "ordinary", isReviewAccount: false }, geo: emptyGeo },
      ],
      assigneeLoadMap: new Map([["ordinary", 100], ["reviewer", 0]]),
    });
    expect(result.assignee._id).toBe("ordinary");
  });

  it("fails closed rather than selecting the sole review candidate", () => {
    expect(() => chooseNearestCrmAssignee({
      leadGeo: emptyGeo,
      assignees: [{ user: { _id: "reviewer", isReviewAccount: true }, geo: emptyGeo }],
      assigneeLoadMap: new Map(),
    })).toThrow("No active CRM users available for assignment");
  });

  it("preserves deterministic workload ranking for ordinary and legacy accounts", () => {
    const result = chooseNearestCrmAssignee({
      leadGeo: emptyGeo,
      assignees: [
        { user: { _id: "legacy" }, geo: emptyGeo },
        { user: { _id: "ordinary", isReviewAccount: false }, geo: emptyGeo },
      ],
      assigneeLoadMap: new Map([["ordinary", 100], ["legacy", 1]]),
    });
    expect(result.assignee._id).toBe("legacy");
    expect(result.method).toBe("load_balance");
  });
});

describe("production Revenue Radar review-account boundary", () => {
  it("queries only ordinary agents and never recommends a contaminated reviewer", async () => {
    fixtures.agents = [
      { _id: "reviewer", username: "Reviewer", isReviewAccount: true, crmAddress: "Toronto" },
      { _id: "ordinary", username: "Ordinary", isReviewAccount: false },
    ];
    fixtures.prospects = [{ _id: "prospect", lead: { companyName: "Synthetic prospect", companyLocation: "Toronto" } }];
    const snapshot = await getRevenueRadarSnapshot();

    expect(fixtures.userFind).toHaveBeenCalledWith(expect.objectContaining({ isReviewAccount: { $ne: true } }));
    expect(fixtures.userSelect.mock.calls[0]?.[0]).toContain("isReviewAccount");
    expect(snapshot.recentProspects[0]?.suggestedAgent).toEqual({ id: "ordinary", label: "Ordinary" });
  });

  it("returns no suggestion when only review candidates are supplied", async () => {
    fixtures.agents = [{ _id: "reviewer", username: "Reviewer", isReviewAccount: true }];
    fixtures.prospects = [{ _id: "prospect", lead: { companyName: "Synthetic prospect" } }];
    const snapshot = await getRevenueRadarSnapshot();
    expect(snapshot.recentProspects[0]?.suggestedAgent).toBeNull();
  });

  it("omits reviewer-owned synthetic leads from production totals and follow-up recommendations", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fixtures.leads = [
      { _id: "review-lead", clientName: "Review fixture", status: "new_lead", dueDate: past,
        assignedTo: { _id: "reviewer", isReviewAccount: true } },
      { _id: "normal-lead", clientName: "Ordinary fixture", status: "new_lead", dueDate: past,
        assignedTo: { _id: "ordinary", isReviewAccount: false } },
      { _id: "legacy-lead", clientName: "Legacy fixture", status: "new_lead", dueDate: past,
        assignedTo: { _id: "legacy" } },
    ];
    const snapshot = await getRevenueRadarSnapshot();

    expect(fixtures.leadPopulate.mock.calls[0]?.[1]).toContain("isReviewAccount");
    expect(fixtures.leadFind).toHaveBeenCalledWith(expect.objectContaining({ isReviewData: { $ne: true } }));
    expect(snapshot.kpis.totalLeads).toBe(2);
    expect(snapshot.staleLeads.map((lead) => lead.id)).toEqual(["normal-lead", "legacy-lead"]);
  });

  it("keeps synthetic rows excluded after their reviewer account is removed", async () => {
    fixtures.leads = [{ _id: "retained-review-lead", isReviewData: true, assignedTo: null }];
    const snapshot = await getRevenueRadarSnapshot();
    expect(snapshot.kpis.totalLeads).toBe(0);
    expect(snapshot.staleLeads).toEqual([]);
  });
});
