import mongoose from "mongoose";
import connectDB from "../config/database.js";
import DeviceAccessChallenge from "../models/deviceAccessChallenge.model.js";
import DeviceRegistration from "../models/deviceRegistration.model.js";
import SecurityAuditEvent from "../models/securityAuditEvent.model.js";
import UserIpObservation from "../models/userIpObservation.model.js";
import User from "../models/user.model.js";
import {
  getDeviceSupportContact,
  validateSupportContact,
  writeSecurityAudit,
} from "../service/deviceAccessService.js";

async function run() {
  await connectDB();
  const support = validateSupportContact(await getDeviceSupportContact());
  await Promise.all([
    DeviceRegistration.syncIndexes(),
    DeviceAccessChallenge.syncIndexes(),
    UserIpObservation.syncIndexes(),
    SecurityAuditEvent.syncIndexes(),
  ]);

  const ordinaryUsers = await User.countDocuments({ role: "user" });
  const usersWithRefreshTokens = await User.countDocuments({
    role: "user",
    $or: [
      { "refreshTokens.0": { $exists: true } },
      { refreshToken: { $exists: true, $nin: [null, ""] } },
    ],
  });
  const apply = /^(true|1|yes)$/i.test(
    String(process.env.DEVICE_APPROVAL_MIGRATION_APPLY || "false")
  );

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        supportContact: support,
        ordinaryUsers,
        usersWithRefreshTokens,
      },
      null,
      2
    )
  );

  if (apply) {
    await User.updateMany(
      { role: "user" },
      { $set: { refreshTokens: [] }, $unset: { refreshToken: "" } }
    );
    await writeSecurityAudit({
      action: "device.enforcement_migration_applied",
      actorType: "system",
      reason: "Cleared ordinary-user legacy refresh tokens before device enforcement activation.",
      after: { affectedUsers: usersWithRefreshTokens },
    });
    console.log("Device approval activation migration completed.");
  } else {
    console.log(
      "Dry run only. Set DEVICE_APPROVAL_MIGRATION_APPLY=true to clear legacy ordinary-user refresh tokens."
    );
  }
}

run()
  .catch((error) => {
    console.error("Device approval activation failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
