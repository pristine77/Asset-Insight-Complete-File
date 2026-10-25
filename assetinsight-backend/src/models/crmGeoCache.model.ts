import mongoose from "mongoose";

const crmGeoCacheSchema = new mongoose.Schema(
  {
    cacheKey: { type: String, required: true, unique: true, index: true },
    sourceText: { type: String, trim: true },
    normalizedText: { type: String, trim: true },
    resolver: { type: String, enum: ["openai", "heuristic", "empty"], default: "heuristic" },
    result: { type: mongoose.Schema.Types.Mixed, default: {} },
    error: { type: String, trim: true },
  },
  { timestamps: true }
);

const CrmGeoCache = mongoose.model("CrmGeoCache", crmGeoCacheSchema);

export default CrmGeoCache;
