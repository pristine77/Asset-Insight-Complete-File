import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Asset from '../src/models/asset.model.js';
import Lot from '../src/models/lotListing.model.js';
import RealEstate from '../src/models/realEstate.model.js';
import User from '../src/models/user.model.js';

let mongo: MongoMemoryServer;
let app: Awaited<typeof import('../src/app.js')>['default'];
let owner: any, other: any;
const originalEnforcement = process.env.DEVICE_APPROVAL_ENFORCEMENT;
const token = () => `Bearer ${jwt.sign({ id: String(owner._id), role: 'user' }, process.env.JWT_SECRET!, { expiresIn: '10m' })}`;
beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = 'off';
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  ({ default: app } = await import('../src/app.js'));
  owner = await User.create({ email: 'queue-owner@example.test', username: 'Queue owner', password: 'Fixture-Only-123!', isVerified: true });
  other = await User.create({ email: 'queue-other@example.test', username: 'Queue other', password: 'Fixture-Only-123!', isVerified: true });
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); process.env.DEVICE_APPROVAL_ENFORCEMENT = originalEnforcement; });
describe('backward-compatible preview list reads', () => {
  it.each([['asset', Asset], ['lot-listing', Lot], ['real-estate', RealEstate]] as const)('%s keeps owner scope, workflow and detail reads while shrinking list payloads', async (path, model) => {
    const images = Array.from({ length: 5000 }, (_, i) => `https://assetinsight.test/photo-${i}.jpg`);
    const rows = [owner, other].map(user => ({ _id: new mongoose.Types.ObjectId(), user: user._id, status: 'processing', job_status: 'queued',
      contract_no: 'same-contract', imageUrls: images, createdAt: new Date(), preview_data: { lots: [{ title: 'Saved details', image_urls: images }] } }));
    await model.collection.insertMany(rows as any);
    const compact = await request(app).get(`/api/${path}?view=previews`).set('Authorization', token());
    expect(compact.status).toBe(200);
    expect(compact.headers['cache-control']).toContain('no-store');
    expect(compact.body.data).toHaveLength(1);
    expect(compact.body.data[0]).toMatchObject({ _id: String(rows[0]._id), workflow_stage: 'preparing_preview', lot_count: 1, image_count: 5000 });
    expect(JSON.stringify(compact.body)).not.toContain(String(rows[1]._id));
    expect(Buffer.byteLength(JSON.stringify(compact.body))).toBeLessThan(2500);
    const legacy = await request(app).get(`/api/${path}`).set('Authorization', token());
    expect(legacy.status).toBe(200); expect(legacy.body.data[0].imageUrls).toHaveLength(5000);
    expect((await model.collection.findOne({ _id: rows[0]._id }))!.imageUrls).toHaveLength(5000);
    expect((await request(app).get(`/api/${path}?view=previews`)).status).toBe(401);
  });
});
