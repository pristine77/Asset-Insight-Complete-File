import mongoose, { Schema } from "mongoose";

/**
 * Local event-scoped reservation receipt. The built-in _id index is the only
 * uniqueness primitive: one CAS atomically advances the counter and remembers
 * each allocation, so a worker restart cannot allocate a second number.
 */
export interface AuctioneerLotNumberLedgerRecord {
  _id: string;
  revision: number;
  highWater: string;
  allocations: Record<string, string>;
}

const schema = new Schema<AuctioneerLotNumberLedgerRecord>(
  {
    _id: { type: String, required: true },
    revision: { type: Number, required: true, default: 0 },
    highWater: { type: String, required: true, default: "0" },
    allocations: { type: Schema.Types.Mixed, required: true, default: () => ({}) },
  },
  { timestamps: true, minimize: false },
);

export default mongoose.model<AuctioneerLotNumberLedgerRecord>(
  "AuctioneerLotNumberLedger",
  schema,
);
