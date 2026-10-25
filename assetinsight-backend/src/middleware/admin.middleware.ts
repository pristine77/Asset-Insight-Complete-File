import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import User from "../models/user.model.js";

export interface AdminAuthRequest extends Request {
  userId?: string;
  user?: any;
}

export const adminProtect = async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { id: string; role?: string };
    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res.status(401).json({ message: "Not authorized, user not found" });
    }
    if ((user as any).isBlocked) {
      return res.status(403).json({ message: "Account is blocked" });
    }
    if (user.role !== "admin" && user.role !== "superadmin") {
      return res.status(403).json({ message: "Admin privileges required" });
    }
    req.user = user;
    req.userId = user._id.toString();
    next();
  } catch (error) {
    return res.status(401).json({ message: "Not authorized, token failed" });
  }
};

export const requireAdmin = (req: AdminAuthRequest, res: Response, next: NextFunction) => {
  const role = (req.user as any)?.role;
  if (role !== "admin" && role !== "superadmin") {
    return res.status(403).json({ message: "Admin privileges required" });
  }
  next();
};

export const requireSuperadmin = (req: AdminAuthRequest, res: Response, next: NextFunction) => {
  const role = (req.user as any)?.role;
  if (role !== "superadmin") {
    return res.status(403).json({ message: "Superadmin privileges required" });
  }
  next();
};

/**
 * Narrows the broad admin authentication boundary to the small set of accounts
 * explicitly provisioned to handle customer support. This middleware must run
 * after adminProtect so the decision uses the current database record instead
 * of a potentially stale JWT claim.
 */
export const requireSupportDeveloper = (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  if ((req.user as any)?.canManageSupport !== true) {
    return res.status(403).json({
      code: "SUPPORT_DEVELOPER_REQUIRED",
      message: "Support developer access required",
    });
  }
  next();
};
