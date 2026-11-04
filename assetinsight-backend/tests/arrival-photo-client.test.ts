import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadArrivalPhotos, listArrivalPhotoRequests, listCompletedArrivalPhotoRequests } from "../src/service/auctioneer2Client.js";
const photo={buffer:Buffer.from("jpeg"),filename:"p.jpg",contentType:"image/jpeg",order:0};
beforeEach(()=>{vi.stubEnv("AUCTIONEER2_API_BASE_URL","https://auctioneer.example/api/external");vi.stubEnv("AUCTIONEER2_API_KEY","synthetic");vi.stubEnv("AUCTIONEER2_ENABLED","true");vi.stubEnv("AUCTIONEER2_FEATURE_ENABLED","true");});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe("arrival receipts",()=>{
  it.each([{},{success:false},{success:true},{success:true,stored:0,skipped:0,photoCount:0},{success:true,stored:"1",skipped:0,photoCount:1},{success:true,stored:-1,skipped:2,photoCount:1},{success:true,stored:1,skipped:0,photoCount:0}])("rejects unconfirmed %j",async body=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(body),{status:201})));
    await expect(uploadArrivalPhotos("r","u",[photo])).rejects.toMatchObject({code:"auctioneer2_invalid_arrival_receipt",ambiguousWrite:true});
  });
  it.each([{success:true,stored:1,skipped:0,photoCount:1},{success:true,stored:0,skipped:1,photoCount:1}])("accepts exact counts %j",async body=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(body),{status:201})));
    await expect(uploadArrivalPhotos("r","u",[photo])).resolves.toEqual({stored:body.stored,skipped:body.skipped,photoCount:body.photoCount});
  });
  it("fails closed on missing list acceptance",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({success:false,items:[]}),{status:200})));
    await expect(listArrivalPhotoRequests("u")).rejects.toMatchObject({code:"auctioneer2_invalid_response"});
  });
  // The Completed list (owner, 2026-11-04): asked for by status, and trusted
  // only when Auctioneer says it is that list. An older Auctioneer ignores the
  // parameter and answers the OPEN requests, which must never read as done.
  it("asks for the completed list and returns it when Auctioneer names it",async()=>{
    const fetch=vi.fn(async()=>new Response(JSON.stringify({success:true,status:"completed",items:[{requestId:"r1",lotNumber:"0563",receivedAt:"2026-11-04T19:20:00Z",photoCount:12}],total:1}),{status:200}));
    vi.stubGlobal("fetch",fetch);
    await expect(listCompletedArrivalPhotoRequests("u")).resolves.toEqual([{requestId:"r1",lotNumber:"0563",receivedAt:"2026-11-04T19:20:00Z",photoCount:12}]);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain("status=completed");
  });
  it("reports unavailable completed history when an older Auctioneer answers the open list",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({success:true,items:[{requestId:"open-1"}],total:1}),{status:200})));
    await expect(listCompletedArrivalPhotoRequests("u")).rejects.toMatchObject({statusCode:503,code:"auctioneer2_completed_history_unavailable"});
  });
  it("retains the deadline after headers when the provider body never finishes",async()=>{
    vi.useFakeTimers();vi.stubEnv("AUCTIONEER2_API_TIMEOUT_MS","1000");
    vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,status:201,text:()=>new Promise(()=>{})})));
    const attempt=uploadArrivalPhotos("r","u",[photo]);
    const assertion=expect(attempt).rejects.toMatchObject({code:"auctioneer2_timeout",ambiguousWrite:true});
    await vi.advanceTimersByTimeAsync(120000);await assertion;
  });
  it("refuses oversized batch before external request",async()=>{
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(uploadArrivalPhotos("r","u",[{...photo,buffer:Buffer.alloc(18*1024*1024)},{...photo,buffer:Buffer.alloc(18*1024*1024)}])).rejects.toMatchObject({code:"auctioneer2_photo_batch_too_large"});
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe("arrival history response validation", () => {
  const completed = { requestId: "done-1", lotId: "lot-1", lotNumber: "0563", description: "Synthetic tractor", receivedAt: "2026-11-04T19:20:00Z", photoCount: 0 };
  const reply = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

  it.each([undefined, "open", null, "waiting"]) ("refuses an unconfirmed completed status %j", async status => {
    reply({ success: true, status, items: [] });
    await expect(listCompletedArrivalPhotoRequests("u")).rejects.toMatchObject({ statusCode: 503, code: "auctioneer2_completed_history_unavailable" });
  });
  it("accepts a confirmed empty history and preserves explicit zero counts", async () => {
    reply({ success: true, status: "completed", items: [] });
    await expect(listCompletedArrivalPhotoRequests("u")).resolves.toEqual([]);
    reply({ success: true, status: "completed", items: [completed] });
    await expect(listCompletedArrivalPhotoRequests("u")).resolves.toEqual([completed]);
  });
  it.each([null, 7, "invalid", [], {}, { ...completed, requestId: " " }])("rejects the whole list when one row is malformed: %j", async bad => {
    reply({ success: true, status: "completed", items: [completed, bad] });
    await expect(listCompletedArrivalPhotoRequests("u")).rejects.toMatchObject({ statusCode: 502, code: "auctioneer2_invalid_response" });
  });
  it.each([-1, 1.5, "2", null, undefined, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid completed photo count %j", async photoCount => {
    reply({ success: true, status: "completed", items: [{ ...completed, photoCount }] });
    await expect(listCompletedArrivalPhotoRequests("u")).rejects.toMatchObject({ statusCode: 502, code: "auctioneer2_invalid_response" });
  });
  it.each(["requestedAt", "requestedBy", "lotId", "lotNumber", "description", "serialNumber", "make", "model", "year", "location", "contractId", "contractNumber", "consignorName", "eventNumber", "receivedAt"])("rejects object-valued display field %s", async field => {
    reply({ success: true, status: "completed", items: [{ ...completed, [field]: { invalid: true } }] });
    await expect(listCompletedArrivalPhotoRequests("u")).rejects.toMatchObject({ statusCode: 502, code: "auctioneer2_invalid_response" });
  });
  it("accepts optional null display fields and existing nested array envelopes", async () => {
    const row = { ...completed, description: null, requestedBy: null, contractNumber: null };
    reply({ success: true, status: "completed", data: { items: [row] } });
    await expect(listCompletedArrivalPhotoRequests("u")).resolves.toEqual([row]);
  });
  it.each([{ items: null }, { items: {}, data: [] }, { data: { success: false, items: [] } }, { items: [completed, completed] }])("refuses malformed or duplicate lists without fallback %j", async fields => {
    reply({ success: true, status: "completed", ...fields });
    await expect(listCompletedArrivalPhotoRequests("u")).rejects.toMatchObject({ statusCode: 502, code: "auctioneer2_invalid_response" });
  });
  it.each([null, { requestId: "open", description: {} }, { requestId: "open", officeOnlyPhotoCount: -1 }])("also rejects malformed waiting rows %j", async row => {
    reply({ success: true, items: [row] });
    await expect(listArrivalPhotoRequests("u")).rejects.toMatchObject({ statusCode: 502, code: "auctioneer2_invalid_response" });
  });
  it("retains waiting-list compatibility and scopes the query to the requested actor", async () => {
    reply({ success: true, items: [{ requestId: "open", officeOnlyPhotoCount: 0 }] });
    await expect(listArrivalPhotoRequests(" scoped actor ")).resolves.toEqual([{ requestId: "open", officeOnlyPhotoCount: 0 }]);
    expect(new URL(String(vi.mocked(fetch).mock.calls[0]?.[0])).searchParams.get("userId")).toBe("scoped actor");
  });
});
