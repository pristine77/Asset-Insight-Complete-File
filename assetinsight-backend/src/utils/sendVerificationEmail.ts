import * as dotenv from "dotenv";
import { Resend } from "resend";
import {
  getVerificationEmailHtml,
  getPasswordResetCodeEmailHtml,
  getPasswordResetEmailHtml,
} from "./emailHtml.js";
import {
  DeviceDecisionEmailInput,
  getDeviceDecisionEmailHtml,
} from "./deviceDecisionEmailHtml.js";

dotenv.config();

interface EmailOptions {
  to: string;
  subject: string;
  htmlContent: string;
  idempotencyKey?: string;
}

const resend = new Resend(process.env.RESEND_API_KEY as string);

export async function sendTransactionalEmail(
  options: EmailOptions
): Promise<string | null> {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("Missing RESEND_API_KEY in environment variables.");
  }

  const fromAddress = "verify@assetinsightvaluator.com"; // Your verified domain sender

  try {
    const response = await resend.emails.send(
      {
        from: `Asset Insight <${fromAddress}>`,
        to: options.to,
        subject: options.subject,
        html: options.htmlContent,
      },
      options.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : undefined
    );
    if (response.error) {
      throw new Error(response.error.message || "Resend rejected the email");
    }
    return response.data?.id || null;
  } catch (error: any) {
    console.error("❌ Failed to send email:", error.message);
    throw error;
  }
}

export const sendEmail = async (
  to: string,
  subject: string,
  html: string
) => {
  await sendTransactionalEmail({ to, subject, htmlContent: html });
};

export async function sendVerificationCode(to: string, code: string) {
  const subject = `Your Asset Insight Verification Code: ${code}`;
  const htmlContent = getVerificationEmailHtml(code);
  await sendTransactionalEmail({ to, subject, htmlContent });
}

export async function sendPasswordResetLink(to: string, resetLink: string) {
  const subject = "Your Asset Insight Password Reset Link";
  const htmlContent = getPasswordResetEmailHtml(resetLink);
  await sendTransactionalEmail({ to, subject, htmlContent });
}

export async function sendPasswordResetCode(to: string, code: string) {
  const subject = `Your Asset Insight Password Reset Code: ${code}`;
  const htmlContent = getPasswordResetCodeEmailHtml(code);
  await sendTransactionalEmail({ to, subject, htmlContent });
}

export async function sendDeviceDecisionEmail(
  to: string,
  input: DeviceDecisionEmailInput
) {
  const decision = input.approved ? "approved" : "rejected";
  const subject = `Your Asset Insight device was ${decision}`;
  const htmlContent = getDeviceDecisionEmailHtml({
    ...input,
    webAppUrl: process.env.WEB_APP_URL,
  });
  await sendTransactionalEmail({ to, subject, htmlContent });
}
