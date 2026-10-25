import mongoose, { Document, Schema } from "mongoose";

export interface ISystemSetting extends Document {
  key: string;
  value: any;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const systemSettingSchema = new Schema<ISystemSetting>(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Schema.Types.Mixed, default: undefined },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: undefined },
  },
  { timestamps: true }
);

export default mongoose.models.SystemSetting ||
  mongoose.model<ISystemSetting>("SystemSetting", systemSettingSchema);
