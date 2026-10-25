import User from "../models/user.model.js";

function toPlainUser(user: any): any {
  if (!user) return user;
  return typeof user.toObject === "function" ? user.toObject() : user;
}

export async function isUserReportApprover(userId: unknown): Promise<boolean> {
  const id = String(userId || "").trim();
  if (!id) return false;
  const assignedUser = await User.exists({
    reportApprover: id,
    isBlocked: { $ne: true },
  });
  return Boolean(assignedUser);
}

export async function isUserReleaseManager(userId: unknown): Promise<boolean> {
  const id = String(userId || "").trim();
  if (!id) return false;
  const assignedUser = await User.exists({
    releaseManager: id,
    isBlocked: { $ne: true },
  });
  return Boolean(assignedUser);
}

export async function attachUserCapabilities(user: any): Promise<any> {
  const plain = toPlainUser(user);
  if (!plain?._id) return plain;
  const [isReportApprover, isReleaseManager] = await Promise.all([
    isUserReportApprover(plain._id),
    isUserReleaseManager(plain._id),
  ]);
  return {
    ...plain,
    isReportApprover,
    isReleaseManager,
  };
}
