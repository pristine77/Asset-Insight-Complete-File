import { describe, expect, it } from "vitest";
import {
  normalizeAuctioneer2Contract,
  normalizeAuctioneer2Lot,
} from "../src/service/auctioneer2IntegrationService.js";
import {
  normalizeAuctioneerEventId,
  readAuctioneerContractIdentityCandidates,
  readAuctioneerEventIdentity,
  resolveAuctioneerEventIdentity,
} from "../src/utils/auctioneerEventIdentity.js";

describe("Auctioneer event identity", () => {
  it("reads only explicit contract identities across the bounded event contexts", () => {
    const source = {
      id: "task-1", uuid: "task-uuid", contractId: " contract-1 ",
      lot: { id: "lot-1", contract: { _id: "contract-1", uuid: "contract-2", eventId: "event-1" } },
      asset: { item: { contract_guid: 0 } },
      item: { lot: { item: { contractId: "too-deep" } } },
    };
    expect(readAuctioneerContractIdentityCandidates(source)).toEqual(["contract-1", "contract-2", "0"]);
    expect(readAuctioneerContractIdentityCandidates({ id: "root-contract", _id: {}, uuid: true }, { standaloneContract: true })).toEqual(["root-contract"]);
    expect(readAuctioneerContractIdentityCandidates({ id: "lot-id", contractId: {}, event: { id: "event-id" } })).toEqual([]);
  });
  it.each([undefined, null, "", "  ", {}, [], true, false, NaN, Infinity, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, 1n])("rejects invalid scalar %s without coercion", (value) => {
    expect(normalizeAuctioneerEventId(value)).toBeUndefined();
  });
  it.each([[" event-guid ", "event-guid"], ["0001", "0001"], [0, "0"], [123, "123"], [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]])("preserves valid opaque identity %s", (value, expected) => {
    expect(normalizeAuctioneerEventId(value)).toBe(expected);
  });
  it.each(["eventId", "event_id", "auctionEventId"])("reads alias %s and skips invalid earlier fields", (alias) => {
    expect(readAuctioneerEventIdentity({ eventId: {}, [alias]: " event-1 ", event: { id: "event-1" } })).toBe("event-1");
  });
  it.each(["lot", "asset", "item", "contract"])("reads proven nested %s event context", (key) => {
    expect(readAuctioneerEventIdentity({ [key]: { event: { id: "event-1" } } })).toBe("event-1");
  });
  it("uses a direct id only in explicitly standalone event context, never a contract/lot ID or title", () => {
    const raw = { id: "unrelated-id", contractId: "contract-1", title: "Sale", eventTitle: "Sale", eventDate: "2026-10-01" };
    expect(readAuctioneerEventIdentity(raw)).toBeUndefined();
    expect(readAuctioneerEventIdentity(raw, { standaloneEvent: true })).toBe("unrelated-id");
    expect(readAuctioneerEventIdentity({ lot: { id: "lot-1", contract: { id: "contract-1", event_id: "event-1" } } })).toBe("event-1");
  });
  it("reconciles equivalent evidence but rejects conflicting aliases and contexts", () => {
    expect(resolveAuctioneerEventIdentity([123, " 123 ", null, {}])).toBe("123");
    expect(() => readAuctioneerEventIdentity({ eventId: "event-1", event: { id: "event-2" } })).toThrowError(expect.objectContaining({ code: "auctioneer_event_identity_conflict" }));
    expect(() => readAuctioneerEventIdentity({ lot: { eventId: "event-1" }, contract: { eventId: "event-2" } })).toThrowError(expect.objectContaining({ code: "auctioneer_event_identity_conflict" }));
    expect(() => resolveAuctioneerEventIdentity(["01", 1])).toThrow();
  });
  it("normalizes contract event aliases without changing unrelated normalization", () => {
    expect(normalizeAuctioneer2Contract({ id: "contract-1", eventId: "  ", event: { id: " event-1 " } })?.eventId).toBe("event-1");
    expect(normalizeAuctioneer2Contract({ id: "contract-1", eventId: {}, auctionEventId: 0 })?.eventId).toBe("0");
    expect(() => normalizeAuctioneer2Contract({ id: "contract-1", eventId: "one", event_id: "two" })).toThrowError(expect.objectContaining({ statusCode: 409, code: "auctioneer_event_identity_conflict" }));
  });
});

describe("Auctioneer 2.0 source normalization", () => {
  it.each([
    { consignorName: " Consignor Ltd ", salespersonName: " Sales Person " },
    { consignor_name: "Consignor Ltd", salesperson_name: "Sales Person" },
    { consignerName: "Consignor Ltd", salesPersonName: "Sales Person" },
    { consigner_name: "Consignor Ltd", sales_person_name: "Sales Person" },
    { consignor: { name: "Consignor Ltd" }, salesperson: { name: "Sales Person" } },
    { consigner: { displayName: "Consignor Ltd" }, salesPerson: { displayName: "Sales Person" } },
    { contract: { id: "contract-1", consignorName: "Consignor Ltd", salespersonName: "Sales Person" } },
  ])("reads explicit contract contact names: %j", (fields) => {
    expect(normalizeAuctioneer2Contract({ id: "contract-1", ...fields }))
      .toMatchObject({ consignorName: "Consignor Ltd", salespersonName: "Sales Person" });
  });

  it.each([undefined, null, " ", {}, [], true, 17, "x".repeat(301)].map((invalid) => ({ invalid })))
    ("ignores malformed contact names, without substituting other roles: $invalid", ({ invalid }) => {
      const normalized = normalizeAuctioneer2Contract({ id: "contract-1", consignorName: invalid, salespersonName: invalid,
        customerName: "Customer is not necessarily consignor", assignedUserName: "Assigned appraiser", ownerName: "Owner", salespersonId: "person-1" });
      expect(normalized?.consignorName).toBeUndefined();
      expect(normalized?.salespersonName).toBeUndefined();
    });

  it("skips invalid name aliases and normalizes control whitespace without mutating provider data", () => {
    const raw = { id: "contract-1", consignorName: {}, consigner_name: "  Québec\n  Equipment\u0000 Ltd ",
      salespersonName: "  ", salesperson: { name: "\tFrançois O’Neil\r\n", email: "private@example.test" } };
    const normalized = normalizeAuctioneer2Contract(raw);
    expect(normalized).toMatchObject({ consignorName: "Québec Equipment Ltd", salespersonName: "François O’Neil" });
    expect(raw.salesperson.name).toBe("\tFrançois O’Neil\r\n");
  });

  it.each([{ description: " Farm equipment " }, { contractDescription: "Farm equipment" }])(
    "reads the contract description: %j", (fields) => {
      expect(normalizeAuctioneer2Contract({ id: "contract-1", ...fields })?.description).toBe("Farm equipment");
    });

  it("does not take the description from a foreign embedded contract", () => {
    expect(normalizeAuctioneer2Contract({ id: "contract-1", contract: { id: "another-contract", description: "Other" } })?.description).toBeUndefined();
  });

  it("does not take names from a foreign embedded contract", () => {
    const normalized = normalizeAuctioneer2Contract({ id: "contract-1", contract: {
      id: "another-contract", consignorName: "Other consignor", salespersonName: "Other salesperson",
    } });
    expect(normalized?.consignorName).toBeUndefined();
    expect(normalized?.salespersonName).toBeUndefined();
  });

  it.each([" ", {}, [], true, 17].map((invalid) => ({ invalid })))("skips invalid earlier assignment and status aliases: $invalid", ({ invalid }) => {
    expect(normalizeAuctioneer2Contract({
      id: "contract-1", status: invalid, contractStatus: " ProposalInAssetInsight ",
      assignedTo: invalid, assignedUserId: " 507f1f77bcf86cd799439011 ",
    })).toMatchObject({ status: "ProposalInAssetInsight", assignedUserId: "507f1f77bcf86cd799439011" });
  });

  it.each([
    { assignedTo: "507f1f77bcf86cd799439011", assignedUserId: "507f1f77bcf86cd799439012" },
    { assignedTo: { id: "507f1f77bcf86cd799439011", _id: "507f1f77bcf86cd799439012" } },
    { status: "ProposalInAssetInsight", contractStatus: "Completed" },
  ])("rejects contradictory explicit authority aliases: %j", (fields) => {
    expect(() => normalizeAuctioneer2Contract({ id: "contract-1", ...fields })).toThrowError(expect.objectContaining({ statusCode: 502, code: "auctioneer2_invalid_response" }));
  });

  it("preserves equivalent owner/status aliases without changing display text selection", () => {
    expect(normalizeAuctioneer2Contract({
      id: "contract-1", status: "ProposalInAssetInsight", contract_status: " proposalinassetinsight ",
      assignedTo: "507F1F77BCF86CD799439011", assignedUserId: " 507f1f77bcf86cd799439011 ",
      customerName: " ", customer_name: "Do not change legacy display selection",
    })).toMatchObject({ status: "ProposalInAssetInsight", assignedUserId: "507F1F77BCF86CD799439011", customerName: undefined });
  });

  it("normalizes nested contract, customer, event, and workflow fields", () => {
    expect(
      normalizeAuctioneer2Contract({
        contract_id: "contract-1",
        contract_no: "C-100",
        customer: { name: "Example Customer" },
        event: {
          id: "event-1",
          title: "Summer Sale",
          date: "2026-08-12T18:00:00.000Z",
          location: "Regina",
        },
        categories: "Heavy Equipment",
        hasScheduleA: true,
        lot_count: 3,
        assignedUser: {
          id: "507f1f77bcf86cd799439011",
          displayName: "Assigned Appraiser",
          email: "appraiser@example.test",
        },
      })
    ).toMatchObject({
      id: "contract-1",
      contractNo: "C-100",
      customerName: "Example Customer",
      eventId: "event-1",
      eventTitle: "Summer Sale",
      eventDate: "2026-08-12T18:00:00.000Z",
      location: "Regina",
      categories: "Heavy Equipment",
      hasScheduleA: true,
      lotCount: 3,
      assignedUserId: "507f1f77bcf86cd799439011",
      assignedUserName: "Assigned Appraiser",
      assignedUserEmail: "appraiser@example.test",
    });
  });

  it("normalizes lot aliases while preserving the opaque source key", () => {
    expect(
      normalizeAuctioneer2Lot(
        {
          lot_number: "17A",
          name: "Excavator",
          asset_description: "Tracked excavator",
          category: "Heavy Equipment",
          serial_no: "SER-100",
          manufacturer: "CAT",
          model: "320",
          manufacture_year: 2020,
          condition_report: "Starts and operates",
          selectedServices: [{ name: "Photography" }, "Condition report"],
          photos: [{ url: "https://files.example/source-1.jpg" }],
        },
        {
          sourceKey: "opaque-source",
          lotId: "lot-1",
          submissionId: "submission-1",
        }
      )
    ).toMatchObject({
      sourceKey: "opaque-source",
      lotId: "lot-1",
      submissionId: "submission-1",
      lotNumber: "17A",
      title: "Excavator",
      description: "Tracked excavator",
      categories: "Heavy Equipment",
      make: "CAT",
      model: "320",
      year: 2020,
      conditionReport: "Starts and operates",
      services: [{ name: "Photography" }, { name: "Condition report" }],
      sourcePhotos: [{ url: "https://files.example/source-1.jpg" }],
    });
  });

  it("prioritizes Auctioneer empLots.rowGuid over display or internal IDs", () => {
    expect(
      normalizeAuctioneer2Lot(
        {
          rowGuid: "auctioneer-row-guid",
          id: "not-the-auctioneer-lot-guid",
          lotId: "legacy-lot-id",
          name: "Loader",
        },
        { sourceKey: "row-guid-source", lotId: "fallback-id" }
      )
    ).toMatchObject({
      sourceKey: "row-guid-source",
      lotId: "auctioneer-row-guid",
      title: "Loader",
    });
  });

  it("preserves VIN and explicit source-year provenance for later enrichment", () => {
    expect(
      normalizeAuctioneer2Lot(
        { serial_number: "VIN: 1HGCM8A63SA004352" },
        { sourceKey: "vin-source" }
      )
    ).toMatchObject({
      serialNumber: "VIN: 1HGCM8A63SA004352",
    });
    expect(
      normalizeAuctioneer2Lot(
        { serial_number: "VIN: 1HGCM8A63SA004352" },
        { sourceKey: "vin-source" }
      ).year
    ).toBeUndefined();
    expect(
      normalizeAuctioneer2Lot(
        {
          serial_number: "VIN: 1HGCM8A63SA004352",
          manufacture_year: 1970,
        },
        { sourceKey: "explicit-year-source" }
      ).year
    ).toBe(1970);
  });
});
