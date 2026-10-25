import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/user.model.js';
import {
  DeviceApiError,
  deviceErrorBody,
  verifyProtectedDeviceRequest,
} from '../service/deviceAccessService.js';

export interface AuthRequest extends Request {
  userId?: string;
  user?: any;
  deviceId?: string;
  authTokenExpiresAt?: number;
  /** Narrow background capability recheck after slow I/O, before accepting work. */
  assertTransferAuthorization?: () => Promise<void>;
}

export const protect = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as {
      id: string;
      did?: string;
      dv?: number;
      exp?: number;
    };

    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return res.status(401).json({ message: 'Not authorized, user not found' });
    }
    if ((user as any).isBlocked) {
      return res.status(403).json({ code: 'ACCOUNT_BLOCKED', message: 'Account is blocked' });
    }

    const device = await verifyProtectedDeviceRequest(user, decoded, req);

    // @ts-ignore
    req.user = user;
    req.userId = user._id.toString(); // For compatibility with other routes
    req.deviceId = device ? String(device._id) : undefined;
    req.authTokenExpiresAt = Number.isFinite(decoded.exp)
      ? Number(decoded.exp) * 1_000
      : undefined;

    next();
  } catch (error) {
    if (error instanceof DeviceApiError) {
      return res.status(error.status).json(deviceErrorBody(error));
    }
    return res.status(401).json({ code: 'INVALID_ACCESS_TOKEN', message: 'Not authorized, token failed' });
  }
};
