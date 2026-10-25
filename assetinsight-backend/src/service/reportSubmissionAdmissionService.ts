import { createHash, randomUUID } from "node:crypto";
import ReportSubmissionAdmission, {
  type ReportSubmissionAdmissionType,
} from "../models/reportSubmissionAdmission.model.js";

const ADMISSION_LEASE_MS = 5 * 60 * 1000;
const ADMISSION_WAIT_MS = 10 * 1000;
const ADMISSION_RETRY_MS = 25;

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const admissionKey = (input: {
  reportType: ReportSubmissionAdmissionType;
  userId: unknown;
  contractClaim: string;
}) =>
  createHash("sha256")
    .update(
      `${input.reportType}:${String(input.userId)}:${input.contractClaim}`,
    )
    .digest("hex");

const isDuplicateAdmission = (error: any) => Number(error?.code) === 11000;

export type ReportSubmissionAdmissionLease = {
  token: string;
  assertOwned: () => Promise<void>;
  release: () => Promise<void>;
};

/**
 * Serialize the short cross-collection admission boundary. Asset/Lot reports
 * and upload sessions have their own durable unique claims, but Mongo cannot
 * enforce one unique index across both collections. This lease closes that
 * check-then-insert race while those collection-local claims are acquired.
 */
export async function acquireReportSubmissionAdmission(input: {
  reportType: ReportSubmissionAdmissionType;
  userId: unknown;
  contractClaim: string | undefined;
}): Promise<ReportSubmissionAdmissionLease | null> {
  if (!input.contractClaim) return null;
  const key = admissionKey({
    reportType: input.reportType,
    userId: input.userId,
    contractClaim: input.contractClaim,
  });
  const token = randomUUID();
  const deadline = Date.now() + ADMISSION_WAIT_MS;
  let acquired = false;

  while (Date.now() <= deadline) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ADMISSION_LEASE_MS);
    try {
      await ReportSubmissionAdmission.create({
        key,
        reportType: input.reportType,
        user: input.userId as any,
        contractClaim: input.contractClaim,
        token,
        expiresAt,
      });
      acquired = true;
      break;
    } catch (error) {
      if (!isDuplicateAdmission(error)) throw error;
      const reclaimed = await ReportSubmissionAdmission.findOneAndUpdate(
        { key, expiresAt: { $lte: now } },
        {
          $set: {
            reportType: input.reportType,
            user: input.userId as any,
            contractClaim: input.contractClaim,
            token,
            expiresAt,
          },
        },
        { returnDocument: "after" },
      )
        .select("+token")
        .lean();
      if (reclaimed && String(reclaimed.token) === token) {
        acquired = true;
        break;
      }
      if (Date.now() > deadline) {
        throw Object.assign(
          new Error(
            "Another request is currently reserving this contract. Retry with the same submission ID.",
          ),
          { code: "REPORT_SUBMISSION_ADMISSION_BUSY", statusCode: 409 },
        );
      }
      await delay(ADMISSION_RETRY_MS);
    }
  }

  if (!acquired) {
    throw Object.assign(
      new Error(
        "Another request is currently reserving this contract. Retry with the same submission ID.",
      ),
      { code: "REPORT_SUBMISSION_ADMISSION_BUSY", statusCode: 409 },
    );
  }

  const assertOwned = async () => {
    const now = new Date();
    const owned = await ReportSubmissionAdmission.updateOne(
      { key, token, expiresAt: { $gt: now } },
      { $set: { expiresAt: new Date(now.getTime() + ADMISSION_LEASE_MS) } },
    );
    if (owned.matchedCount !== 1) {
      throw Object.assign(
        new Error(
          "The contract reservation expired while this submission was starting. Retry with the same submission ID.",
        ),
        { code: "REPORT_SUBMISSION_ADMISSION_LOST", statusCode: 409 },
      );
    }
  };

  let released = false;
  return {
    token,
    assertOwned,
    release: async () => {
      if (released) return;
      released = true;
      await ReportSubmissionAdmission.deleteOne({ key, token });
    },
  };
}

export async function withReportSubmissionAdmission<T>(
  input: {
    reportType: ReportSubmissionAdmissionType;
    userId: unknown;
    contractClaim: string | undefined;
  },
  work: (lease: ReportSubmissionAdmissionLease | null) => Promise<T>,
): Promise<T> {
  const lease = await acquireReportSubmissionAdmission(input);
  try {
    return await work(lease);
  } finally {
    await lease?.release().catch((error) => {
      // The lease is short-lived and TTL-backed. A cleanup failure must not
      // turn a successfully persisted report into an apparent failed request,
      // which could encourage the caller to submit the same work again.
      console.error("Failed to release report submission admission:", error);
    });
  }
}

export async function findActiveUploadSessionContractOwner(input: {
  reportType: ReportSubmissionAdmissionType;
  userId: unknown;
  contractClaim: string | undefined;
  excludeSessionId?: unknown;
}) {
  // Contract numbers may intentionally be shared by several reports/uploads.
  // Exact retry ownership is enforced by clientSubmissionId instead.
  void input;
  return null;
}

export function activeUploadSessionConflict(owner: any) {
  return Object.assign(
    new Error("An upload for this contract is already in progress."),
    {
      code: "ACTIVE_REPORT_EXISTS",
      statusCode: 409,
      data: owner
        ? {
            sessionId: String(owner._id),
            reportId: owner.reportId,
            jobId: owner.jobId,
            status: owner.status,
          }
        : undefined,
    },
  );
}
