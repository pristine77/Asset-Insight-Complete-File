import mongoose, { Document, Schema, Types } from "mongoose";

export interface ISpecSheetParentCategory extends Document {
  name: string;
  normalizedName: string;
  description?: string;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const SpecSheetParentCategorySchema = new Schema<ISpecSheetParentCategory>(
  {
    name: { type: String, required: true, trim: true, maxlength: 180 },
    normalizedName: { type: String, required: true, unique: true, index: true },
    description: { type: String, trim: true, maxlength: 1000 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default mongoose.model<ISpecSheetParentCategory>(
  "SpecSheetParentCategory",
  SpecSheetParentCategorySchema
);
