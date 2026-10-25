/**
 * Composes transactional email templates for the asset approval lifecycle and delegates
 * delivery to the shared transport, keeping workflow code separate from subjects, URLs,
 * and HTML composition.
 */
import { sendEmail } from "../utils/sendVerificationEmail.js";
import { IAssetReport } from "../models/asset.model.js";

/**
 * Send email when preview data is ready for user review
 */
export async function sendPreviewReadyEmail(
  userEmail: string,
  userName: string,
  reportId: string
): Promise<void> {
  const subject = "Asset Report Preview Ready - Review Your Data";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="display:none;font-size:1px;color:#fff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Your asset report preview is ready.</div>
      <div style="background:#DC2626; padding: 30px; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 28px;">Preview Ready!</h1>
      </div>
      
      <div style="padding: 30px; background: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">
          Hello ${userName},
        </p>
        
        <p style="font-size: 16px; color: #374151; line-height: 1.6;">
          Great news! Your asset report has been processed by our software and is now ready for preview.
        </p>
        <div style="background: #FEE2E2; border-left: 4px solid #DC2626; padding: 15px; margin: 20px 0;">
          <p style="margin: 0; color: #991B1B; font-weight: bold;">Next Steps:</p>
          <p style="margin: 10px 0 0 0; color: #991B1B;">
            Please open the app or web app to review your preview, then verify and authenticate all details before sending your report for approval. You will receive an email notification once your Manager has completed their review.
          </p>
        </div>
        <p style="font-size: 16px; color: #374151; line-height: 1.6;">
          Please sign in to your Asset Insight app or web app to access the preview.
        </p>
        <p style="font-size: 16px; color: #374151; line-height: 1.6;">Thank you!</p>
        
        <p style="font-size: 14px; color: #6B7280; margin-top: 30px;">
          Report ID: <strong>${reportId}</strong>
        </p>
      </div>
      
      <div style="background: #F9FAFB; padding: 20px; text-align: center; font-size: 12px; color: #6B7280;">
        <p style="margin: 0;">© ${new Date().getFullYear()} Asset Insight. All rights reserved.</p>
      </div>
    </div>
  `;

  await sendEmail(userEmail, subject, html);
}

/**
 * Send email when user submits preview for admin approval
 */
export async function sendPreviewSubmittedEmail(
  userEmail: string,
  userName: string,
  reportId: string
): Promise<void> {
  const subject = "Asset Report Submitted for Approval";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="display:none;font-size:1px;color:#fff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Your asset report was submitted for approval.</div>
      <div style="background:#059669; padding: 30px; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 28px;">✓ Successfully Submitted</h1>
      </div>
      
      <div style="padding: 30px; background: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">
          Hello ${userName},
        </p>
        
        <p style="font-size: 16px; color: #374151; line-height: 1.6;">
          Your asset report has been successfully submitted for Manager approval.
        </p>
        
        <p style="font-size: 16px; color: #374151; line-height: 1.6;">
          You will receive an email notification once the Manager has reviewed and processed your report.
        </p>
        
        <div style="background: #D1FAE5; border-left: 4px solid #10B981; padding: 15px; margin: 20px 0;">
          <p style="margin: 0; color: #065F46;"><strong>Status:</strong> Pending Manager Approval</p>
          <p style="margin: 5px 0 0 0; color: #065F46; font-size: 14px;">Expected processing time: 1-2 business days</p>
        </div>
        
        <p style="font-size: 14px; color: #6B7280; margin-top: 30px;">
          Report ID: <strong>${reportId}</strong>
        </p>
      </div>
      
      <div style="background: #F9FAFB; padding: 20px; text-align: center; font-size: 12px; color: #6B7280;">
        <p style="margin: 0;">© ${new Date().getFullYear()} Asset Insight. All rights reserved.</p>
      </div>
    </div>
  `;

  await sendEmail(userEmail, subject, html);
}

/**
 * Send email to admin when report is submitted for approval
 */
export async function sendAdminApprovalRequestEmail(
  adminEmail: string,
  userName: string,
  userEmail: string,
  reportId: string
): Promise<void> {
  const subject = `New Asset Report Approval Request from ${userName}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="display:none;font-size:1px;color:#fff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">A new asset report is awaiting your approval.</div>
      <div style="background:#D97706; padding: 30px; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 28px;">⚠️ Approval Required</h1>
      </div>
      
      <div style="padding: 30px; background: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">
          A new asset report requires your approval.
        </p>
        
        <div style="background: #FEF3C7; border-left: 4px solid #F59E0B; padding: 15px; margin: 20px 0;">
          <p style="margin: 0; color: #92400E;"><strong>Submitted By:</strong> ${userName}</p>
          <p style="margin: 5px 0; color: #92400E;"><strong>Email:</strong> ${userEmail}</p>
          <p style="margin: 5px 0 0 0; color: #92400E;"><strong>Report ID:</strong> ${reportId}</p>
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${process.env.CLIENT_URL}/admin/approvals" 
             style="background:#D97706; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; margin-right: 10px;">
            Review Report
          </a>
        </div>
      </div>
      
      <div style="background: #F9FAFB; padding: 20px; text-align: center; font-size: 12px; color: #6B7280;">
        <p style="margin: 0;">© ${new Date().getFullYear()} Asset Insight. All rights reserved.</p>
      </div>
    </div>
  `;

  await sendEmail(adminEmail, subject, html);
}

/**
 * Send email when admin approves the report
 */
export async function sendReportApprovedEmail(
  userEmail: string,
  userName: string,
  reportId: string
): Promise<void> {
  const subject = "Asset Report Approved - Ready for Download";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="display:none;font-size:1px;color:#fff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Your asset report was approved and is ready for download.</div>
      <div style="background:#059669; padding: 30px; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 28px;">🎉 Report Approved!</h1>
      </div>
      
      <div style="padding: 30px; background: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">
          Hello ${userName},
        </p>
        
        <p style="font-size: 16px; color: #374151; line-height: 1.6;">
          Great news! Your asset report has been approved by the Manager and is now ready for download.
        </p>
        
        <div style="background: #D1FAE5; border-left: 4px solid #10B981; padding: 15px; margin: 20px 0;">
          <p style="margin: 0; color: #065F46; font-weight: bold;">✓ Status: Approved</p>
          <p style="margin: 10px 0 0 0; color: #065F46;">Your report is available for download in multiple formats.</p>
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${process.env.CLIENT_URL}/reports?highlight=${reportId}" 
             style="background:#059669; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
            Download Report
          </a>
        </div>
        
        <p style="font-size: 14px; color: #6B7280; margin-top: 30px;">
          Report ID: <strong>${reportId}</strong>
        </p>
      </div>
      
      <div style="background: #F9FAFB; padding: 20px; text-align: center; font-size: 12px; color: #6B7280;">
        <p style="margin: 0;">© ${new Date().getFullYear()} Asset Insight. All rights reserved.</p>
      </div>
    </div>
  `;

  await sendEmail(userEmail, subject, html);
}

/**
 * Send email when admin declines the report
 */
export async function sendReportDeclinedEmail(
  userEmail: string,
  userName: string,
  reportId: string,
  reason: string
): Promise<void> {
  const subject = "Asset Report Declined - Action Required";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="display:none;font-size:1px;color:#fff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Your asset report was declined.</div>
      <div style="background:#B91C1C; padding: 30px; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 28px;">Report Declined</h1>
      </div>
      
      <div style="padding: 30px; background: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">
          Hello ${userName},
        </p>
        
        <p style="font-size: 16px; color: #374151; line-height: 1.6;">
          Your asset report has been reviewed and declined by the Manager.
        </p>
        
        <div style="background: #FEE2E2; border-left: 4px solid #EF4444; padding: 15px; margin: 20px 0;">
          <p style="margin: 0; color: #991B1B; font-weight: bold;">Reason for Decline:</p>
          <p style="margin: 10px 0 0 0; color: #991B1B;">${reason}</p>
        </div>
        
        <p style="font-size: 16px; color: #374151; line-height: 1.6;">
          You can edit the preview data and resubmit the report for approval.
        </p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${process.env.CLIENT_URL}/reports?highlight=${reportId}" 
             style="background:#B91C1C; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
            Edit & Resubmit
          </a>
        </div>
        
        <p style="font-size: 14px; color: #6B7280; margin-top: 30px;">
          Report ID: <strong>${reportId}</strong>
        </p>
      </div>
      
      <div style="background: #F9FAFB; padding: 20px; text-align: center; font-size: 12px; color: #6B7280;">
        <p style="margin: 0;">© ${new Date().getFullYear()} Asset Insight. All rights reserved.</p>
      </div>
    </div>
  `;

  await sendEmail(userEmail, subject, html);
}
