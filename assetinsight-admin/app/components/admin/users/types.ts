export type AssignmentOption = {
  _id: string;
  email: string;
  username?: string;
  companyName?: string;
  avatarUrl?: string;
  avatarUploadedAt?: string;
  role?: string;
};

export type AdminUserListItem = {
  _id: string;
  email: string;
  username?: string;
  companyName?: string;
  avatarUrl?: string;
  avatarUploadedAt?: string;
  role: string;
  isBlocked: boolean;
  isCrmAgent?: boolean;
  proposalValuationEnabled?: boolean;
  reportApprover?: AssignmentOption | string | null;
  releaseManager?: AssignmentOption | string | null;
  createdAt: string;
  updatedAt?: string;
};

export type AdminUserProfile = AdminUserListItem & {
  contactEmail?: string;
  contactPhone?: string;
  companyAddress?: string;
  crmAddress?: string;
  crmQuadrant?: string;
  crmSpecializations?: string[];
  crmAssignedAt?: string;
  isVerified?: boolean;
  authProvider?: string;
  msOutlookCalendarConnected?: boolean;
  msOutlookConnectedEmail?: string;
  msOutlookConnectedAt?: string;
  cvUrl?: string;
  cvFilename?: string;
  cvUploadedAt?: string;
};

export type AdminUsersResponse = {
  items: AdminUserListItem[];
  total: number;
  page: number;
  limit: number;
  assignmentOptions?: AssignmentOption[];
};

export type PreviewSupervisorSettingResponse = {
  previewSupervisor?: AssignmentOption | null;
  options: AssignmentOption[];
};

export function assignmentId(value?: AssignmentOption | string | null): string {
  if (!value) return "";
  return typeof value === "string" ? value : value._id;
}

export function assignmentLabel(option: AssignmentOption): string {
  const name = option.username || option.companyName || option.email;
  return option.role === "superadmin" ? `${name} (Super Admin)` : name;
}

export function userDisplayName(user: Pick<AdminUserListItem, "username" | "companyName" | "email">): string {
  return user.username || user.companyName || user.email;
}
