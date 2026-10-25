import mongoose, { Document, Schema, Types } from "mongoose";

export interface ISpecSheetField {
  _id?: Types.ObjectId;
  name: string;
  normalizedName: string;
  order: number;
  type: "text" | "number" | "select" | "checkbox";
  required: boolean;
  options: string[];
}

export interface ISpecSheetCategory extends Document {
  name: string;
  normalizedName: string;
  description?: string;
  parentCategory?: Types.ObjectId;
  fields: ISpecSheetField[];
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const SpecSheetFieldSchema = new Schema<ISpecSheetField>(
  {
    name: { type: String, required: true, trim: true, maxlength: 180 },
    normalizedName: { type: String, required: true, trim: true },
    order: { type: Number, required: true, min: 1 },
    type: {
      type: String,
      enum: ["text", "number", "select", "checkbox"],
      default: "text",
    },
    required: { type: Boolean, default: false },
    options: {
      type: [String],
      default: [],
    },
  },
  { _id: true }
);

const SpecSheetCategorySchema = new Schema<ISpecSheetCategory>(
  {
    name: { type: String, required: true, trim: true, maxlength: 180 },
    normalizedName: { type: String, required: true, index: true },
    description: { type: String, trim: true, maxlength: 1000 },
    parentCategory: {
      type: Schema.Types.ObjectId,
      ref: "SpecSheetParentCategory",
      index: true,
    },
    fields: { type: [SpecSheetFieldSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Child category names can repeat under different parent categories in the
// source workbooks. Keep uniqueness scoped to the parent instead of global.
SpecSheetCategorySchema.index(
  { parentCategory: 1, normalizedName: 1 },
  { unique: true, name: "parentCategory_normalizedName_unique" }
);

export default mongoose.model<ISpecSheetCategory>(
  "SpecSheetCategory",
  SpecSheetCategorySchema
);
