export type DeviceStatus =
  | "pending"
  | "rerequest_pending"
  | "approved"
  | "rejected"
  | "revoked";

export type DeviceUser = {
  _id: string;
  email: string;
  username?: string;
  companyName?: string;
  contactEmail?: string;
  contactPhone?: string;
  deviceApprovalMode?: "per_device" | "all_devices";
};

export type IpObservation = {
  id: string;
  _id?: string;
  ip: string;
  blocked: boolean;
  reason?: string;
  blockReason?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  count?: number;
  source?: "observed" | "admin";
  user?: DeviceUser;
  devices?: Array<{
    _id: string;
    displayName: string;
    platform: string;
    formFactor: string;
    status: DeviceStatus;
  }>;
};

export type DeviceRegistration = {
  id: string;
  user: DeviceUser;
  platform: "web" | "android" | "ios";
  formFactor: "desktop" | "mobile" | "tablet";
  displayName: string;
  metadata: Record<string, unknown>;
  status: DeviceStatus;
  requestCount: number;
  requestHistory?: string[];
  requestedAt?: string;
  lastRequestAt?: string;
  decidedAt?: string;
  decisionReason?: string;
  approvedVia?: "device" | "all_devices";
  lastSeenAt?: string;
  lastIp?: string;
  ips: IpObservation[];
  createdAt: string;
  updatedAt: string;
};

export type DeviceSummary = Record<DeviceStatus, number> & {
  blocked_ips: number;
  requests: number;
};

export type Pagination = {
  page: number;
  limit: number;
  total: number;
  pages: number;
};

export type AuditEvent = {
  _id: string;
  action: string;
  actorType: string;
  actor?: { email?: string; username?: string };
  reason?: string;
  before?: unknown;
  after?: unknown;
  createdAt: string;
};

export type DeviceDetailResponse = {
  device: DeviceRegistration;
  ipObservations: IpObservation[];
  audit: AuditEvent[];
};

export type SupportContact = { name: string; email: string; phone: string };
