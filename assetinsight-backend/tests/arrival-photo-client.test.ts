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
  it("shows nothing as completed when an older Auctioneer answers the open list",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({success:true,items:[{requestId:"open-1"}],total:1}),{status:200})));
    await expect(listCompletedArrivalPhotoRequests("u")).resolves.toEqual([]);
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
