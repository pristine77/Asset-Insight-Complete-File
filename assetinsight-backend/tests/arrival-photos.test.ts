import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ upload: vi.fn(), watermark: vi.fn() }));
vi.mock("../src/service/auctioneer2Client.js", async original => ({
  ...await original<typeof import("../src/service/auctioneer2Client.js")>(),
  listArrivalPhotoRequests: vi.fn(async () => [{ requestId:"request-1" }]),
  uploadArrivalPhotos: mocks.upload,
}));
vi.mock("../src/utils/imageProcessing.js", () => ({ processImageWithLogo: mocks.watermark }));
import { Auctioneer2ClientError } from "../src/service/auctioneer2Client.js";
import { sendArrivalPhotos, listMyArrivalPhotoRequests, MAX_ARRIVAL_PHOTOS_PER_SEND } from "../src/service/arrivalPhotoService.js";
import ArrivalPhotoTransfer from "../src/models/arrivalPhotoTransfer.model.js";
const photo = (name: string, mimetype="image/jpeg") => ({buffer:Buffer.from(name), originalname:name, mimetype});
let mongo:MongoMemoryServer;
beforeAll(async () => { mongo=await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  vi.restoreAllMocks(); mocks.upload.mockReset(); mocks.watermark.mockReset(); await ArrivalPhotoTransfer.deleteMany({});
  let count=0;
  mocks.watermark.mockImplementation(async(buffer:Buffer)=>({buffer:Buffer.concat([buffer,Buffer.from("+logo")]),format:"jpeg"}));
  mocks.upload.mockImplementation(async(_req:string,_user:string,photos:any[])=>({stored:photos.length,skipped:0,photoCount:count+=photos.length}));
});

describe("bounded arrival transfer and durable receipts",()=>{
  it("watermarks and sends all 60 photos in bounded ordered batches",async()=>{
    const files=Array.from({length:60},(_,i)=>photo(`p${i}.jpg`));
    expect(await sendArrivalPhotos("u","r",files)).toEqual({sent:60,stored:60,skipped:0,photoCount:60});
    expect(mocks.upload.mock.calls.map(call=>call[2].length)).toEqual(Array(12).fill(5));
    expect(mocks.upload.mock.calls.flatMap(call=>call[2].map((p:any)=>p.order))).toEqual(Array.from({length:60},(_,i)=>i));
    expect(mocks.watermark).toHaveBeenCalledTimes(60);
  });
  it("does not watermark all originals before the first batch is sent",async()=>{
    mocks.upload.mockImplementation(async(_r,_u,photos)=>{expect(mocks.watermark.mock.calls.length).toBeLessThanOrEqual(5);return {stored:photos.length,skipped:0,photoCount:photos.length};});
    await sendArrivalPhotos("u","r",Array.from({length:5},(_,i)=>photo(String(i))));
  });
  it("limits decoded batches to35MB even when fewer than five images fit",async()=>{
    const files=Array.from({length:6},(_,i)=>({...photo(String(i)),buffer:Buffer.alloc(12*1024*1024,i)}));
    await sendArrivalPhotos("u","r",files);
    expect(mocks.upload.mock.calls.map(call=>call[2].length)).toEqual([2,2,2]);
    expect(mocks.upload.mock.calls.every(call=>call[2].reduce((n:number,p:any)=>n+p.buffer.length,0)<=35*1024*1024)).toBe(true);
  });
  it("replays a durable complete receipt after a lost client response without sending bytes, regardless of filenames",async()=>{
    const files=[photo("front")];
    const first=await sendArrivalPhotos("u","r",files);
    expect(await sendArrivalPhotos("u","r",[{...files[0]!,originalname:"new-random-file.jpg"}])).toEqual(first);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
  it("resumes only unconfirmed photos after a definitive refused second batch",async()=>{
    let call=0;
    mocks.upload.mockImplementation(async(_r,_u,photos)=>{if(++call===2) throw new Auctioneer2ClientError("Refused",{statusCode:409,upstreamStatus:409,code:"refused"});return {stored:photos.length,skipped:0,photoCount:photos.at(-1).order+1};});
    const files=Array.from({length:7},(_,i)=>photo(String(i)));
    await expect(sendArrivalPhotos("u","r",files)).rejects.toMatchObject({code:"refused"});
    expect(await sendArrivalPhotos("u","r",files)).toEqual({sent:7,stored:7,skipped:0,photoCount:7});
    expect(mocks.upload.mock.calls.map(call=>call[2].map((p:any)=>p.order))).toEqual([[0,1,2,3,4],[5,6],[5,6]]);
  });
  it.each([new Auctioneer2ClientError("Timeout",{statusCode:504,code:"timeout",ambiguousWrite:true}),new Auctioneer2ClientError("Malformed",{statusCode:502,code:"invalid",upstreamStatus:201,ambiguousWrite:true})])("quarantines uncertain outcomes and never replays bytes",async error=>{
    mocks.upload.mockRejectedValue(error);
    await expect(sendArrivalPhotos("u","r",[photo("front")])).rejects.toMatchObject({code:"arrival_photos_unconfirmed"});
    await expect(sendArrivalPhotos("u","r",[photo("front")])).rejects.toMatchObject({code:"arrival_photos_unconfirmed"});
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
  it("fences concurrent sends to the same request",async()=>{
    let release!:(value:any)=>void;let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
    mocks.upload.mockImplementation(()=>{entered();return new Promise(r=>release=r);});
    const first=sendArrivalPhotos("u","r",[photo("front")]); await started;
    await expect(sendArrivalPhotos("u","r",[photo("front")])).rejects.toMatchObject({code:"arrival_photos_unconfirmed"});
    release({stored:1,skipped:0,photoCount:1});await first;expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
  it("refuses changed selections after confirmed progress, retaining the original receipt",async()=>{
    await sendArrivalPhotos("u","r",[photo("front")]);
    await expect(sendArrivalPhotos("u","r",[photo("other")])).rejects.toMatchObject({code:"arrival_photos_selection_changed"});
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
  it("separates actors and requests",async()=>{
    await sendArrivalPhotos("u","r",[photo("front")]);await sendArrivalPhotos("u2","r",[photo("front")]);await sendArrivalPhotos("u","r2",[photo("front")]);
    expect(mocks.upload).toHaveBeenCalledTimes(3);
  });
  it("accepts all-skipped provider receipt counts",async()=>{
    mocks.upload.mockResolvedValue({stored:0,skipped:2,photoCount:1});
    expect(await sendArrivalPhotos("u","r",[photo("same"),photo("same")])).toEqual({sent:2,stored:0,skipped:2,photoCount:1});
  });
  it("rejects mixed non-image selections before any side effect",async()=>{
    await expect(sendArrivalPhotos("u","r",[photo("good"),photo("bad","video/mp4")])).rejects.toMatchObject({code:"arrival_photos_invalid_type"});
    expect(mocks.upload).not.toHaveBeenCalled();expect(mocks.watermark).not.toHaveBeenCalled();expect(await ArrivalPhotoTransfer.countDocuments()).toBe(0);
  });
  it("rejects empty, oversized files and too many originals before side effects",async()=>{
    await expect(sendArrivalPhotos("u","r",[])).rejects.toMatchObject({code:"arrival_photos_required"});
    await expect(sendArrivalPhotos("u","r",Array.from({length:MAX_ARRIVAL_PHOTOS_PER_SEND+1},()=>photo("x")))).rejects.toMatchObject({code:"arrival_photos_too_many"});
    await expect(sendArrivalPhotos("u","r",[{...photo("x"),buffer:Buffer.alloc(20*1024*1024+1)}])).rejects.toMatchObject({code:"arrival_photos_too_large"});
    expect(mocks.upload).not.toHaveBeenCalled();expect(mocks.watermark).not.toHaveBeenCalled();
  });
  it("allows retry after local preparation fails before external writes",async()=>{
    mocks.watermark.mockRejectedValueOnce(new Error("decode failed"));
    await expect(sendArrivalPhotos("u","r",[photo("front")])).rejects.toThrow("decode failed");
    await expect(sendArrivalPhotos("u","r",[photo("front")])).resolves.toMatchObject({sent:1});
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
  it("allows correcting the selection after local preparation failed before any external write",async()=>{
    mocks.watermark.mockRejectedValueOnce(new Error("decode failed"));
    await expect(sendArrivalPhotos("u","r",[photo("bad-original")])).rejects.toThrow("decode failed");
    expect(await ArrivalPhotoTransfer.countDocuments()).toBe(0);
    await expect(sendArrivalPhotos("u","r",[photo("corrected-original")])).resolves.toMatchObject({sent:1});
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
  it("quarantines a receipt whose photo count drops below already confirmed stored photos",async()=>{
    mocks.upload.mockResolvedValueOnce({stored:5,skipped:0,photoCount:5}).mockResolvedValueOnce({stored:1,skipped:0,photoCount:1});
    const files=Array.from({length:6},(_,i)=>photo(String(i)));
    await expect(sendArrivalPhotos("u","r",files)).rejects.toMatchObject({code:"arrival_photos_unconfirmed"});
    await expect(sendArrivalPhotos("u","r",files)).rejects.toMatchObject({code:"arrival_photos_unconfirmed"});
    expect(mocks.upload).toHaveBeenCalledTimes(2);
  });
  it("retains uncertainty when accepted receipt cannot be saved",async()=>{
    const original=ArrivalPhotoTransfer.findOneAndUpdate.bind(ArrivalPhotoTransfer);
    vi.spyOn(ArrivalPhotoTransfer,"findOneAndUpdate").mockImplementation(((filter:any,update:any,options:any)=> update.$inc ? {lean:async()=>{throw new Error("db unavailable");}} : original(filter,update,options)) as any);
    await expect(sendArrivalPhotos("u","r",[photo("front")])).rejects.toMatchObject({code:"arrival_photos_unconfirmed"});
    await expect(sendArrivalPhotos("u","r",[photo("front")])).rejects.toMatchObject({code:"arrival_photos_unconfirmed"});
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
  it("lists actor-scoped requests",async()=>expect(await listMyArrivalPhotoRequests("u")).toEqual([{requestId:"request-1"}]));
});
