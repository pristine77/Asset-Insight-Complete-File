import { describe, expect, it } from "vitest";
import { crmTaskQueryString, legacyCrmDestination, parseCrmTaskQuery } from "./crmRoutePolicy";

describe("CRM route query policy", () => {
  it("keeps canonical dashboard drill-down filters and bounded page sizes", () => {
    const query = parseCrmTaskQuery(new URLSearchParams("q=Smith+%28%2B1%29&status=all&leadSource=organic&due=overdue&page=3&limit=50&owner=other"));
    expect(query).toEqual({ q: "Smith (+1)", status: "all", leadSource: "organic", due: "overdue", page: 3, limit: 50 });
    expect(parseCrmTaskQuery(new URLSearchParams(crmTaskQueryString(query)))).toEqual(query);
  });
  it.each(["-1", "0", "1.5", "1e2", "Infinity", "9007199254740991", "invalid"])("rejects unsafe page %s", (page) => {
    expect(parseCrmTaskQuery(new URLSearchParams({ page, limit: "200", status: "injected", leadSource: "website", due: "today" }))).toEqual({ page: 1, limit: 20, status: undefined, leadSource: undefined, due: undefined, q: undefined });
  });
  it("preserves all eight stages and canonical source/due values", () => {
    expect(parseCrmTaskQuery(new URLSearchParams("status=lost&due=upcoming&leadSource=generic"))).toMatchObject({ status: "lost", due: "upcoming", leadSource: "generic" });
    expect(parseCrmTaskQuery(new URLSearchParams("status=archived"))).toMatchObject({ status: "won" });
    expect(crmTaskQueryString({ page: 1, limit: 20 })).toBe("");
    expect(parseCrmTaskQuery(new URLSearchParams({ q: "x".repeat(200) })).q).toHaveLength(150);
  });
  it("normalizes legacy task and tab links without silently dropping IDs or filters", () => {
    expect(legacyCrmDestination(new URLSearchParams("task=abc&q=Alex"))).toBe("/crm/tasks?task=abc&q=Alex");
    expect(legacyCrmDestination(new URLSearchParams("view=transfers&task=abc"))).toBe("/crm/transfers?task=abc");
    expect(legacyCrmDestination(new URLSearchParams("view=outlook"))).toBe("/crm/outlook");
    expect(legacyCrmDestination(new URLSearchParams("view=tasks"))).toBe("/crm/tasks");
    expect(legacyCrmDestination(new URLSearchParams())).toBeNull();
    expect(legacyCrmDestination(new URLSearchParams("view=javascript:alert(1)"))).toBeNull();
  });
});
