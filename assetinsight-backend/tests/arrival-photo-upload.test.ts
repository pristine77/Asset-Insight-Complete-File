import express from "express";
import request from "supertest";
import { stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/utils/imageProcessing.js",()=>({processImageWithLogo:vi.fn()}));
import { arrivalPhotoUpload, cleanupArrivalPhotoUpload } from "../src/middleware/arrivalPhotoUpload.js";

describe("arrival upload staging",()=>{
  it("stages originals privately on disk and removes them after use",async()=>{
    let path="";const app=express();
    app.post("/photos",arrivalPhotoUpload,async(req,res)=>{
      const file=(req.files as Express.Multer.File[])[0]!;path=file.path;
      expect(file.buffer).toBeUndefined();expect((await stat(path)).mode&0o777).toBe(0o600);
      await cleanupArrivalPhotoUpload(req);res.json({ok:true});
    });
    await request(app).post("/photos").attach("photos",Buffer.from("synthetic"),"p.jpg").expect(200);
    await expect(stat(path)).rejects.toMatchObject({code:"ENOENT"});
  });
  it("refuses a non-image multipart selection instead of silently dropping it",async()=>{
    const app=express();const handler=vi.fn((_req,res)=>res.sendStatus(200));app.post("/photos",arrivalPhotoUpload,handler);
    const result=await request(app).post("/photos").attach("photos",Buffer.from("x"),"notes.pdf");
    expect(result.status).toBe(400);expect(result.body.success).toBe(false);expect(handler).not.toHaveBeenCalled();
  });
  it("returns structured upload limits and releases capacity after failures",async()=>{
    const app=express();app.post("/photos",arrivalPhotoUpload,async(req,res)=>{await cleanupArrivalPhotoUpload(req);res.sendStatus(200);});
    for(let index=0;index<3;index++) {
      const result=await request(app).post("/photos").attach("photos",Buffer.alloc(20*1024*1024+1),"p.jpg");
      expect(result.status).toBe(413);expect(result.body.code).toBe("arrival_photos_upload_limit");
    }
    await request(app).post("/photos").attach("photos",Buffer.from("x"),"p.jpg").expect(200);
  });
});
