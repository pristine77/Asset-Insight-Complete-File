export function getVerificationEmailHtml(code: string): string {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your SellSnap Verification Code</title>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
      body {
        margin: 0;
        padding: 0;
        font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        background-color: #f4f7fa;
        color: #333;
      }
      .email-wrapper {
        padding: 20px;
        background-color: #f4f7fa;
      }
      .email-container {
        max-width: 600px;
        margin: 0 auto;
        background-color: #ffffff;
        border-radius: 16px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.08);
        overflow: hidden;
      }
      .email-header {
        background: linear-gradient(135deg, #ff6b6b, #ff4757);
        padding: 40px 20px;
        text-align: center;
      }
      .email-header h1 {
        margin: 0;
        font-size: 32px;
        font-weight: 700;
        color: #ffffff;
        text-shadow: 1px 1px 3px rgba(0,0,0,0.1);
      }
      .email-body {
        padding: 40px 30px;
        text-align: center;
      }

      .email-body h2 {
        font-size: 24px;
        font-weight: 600;
        color: #1c1e21;
        margin-top: 0;
        margin-bottom: 15px;
      }
      .email-body p {
        font-size: 16px;
        line-height: 1.7;
        color: #555;
        margin-bottom: 25px;
      }
      .verification-code-container {
        background-color: rgba(255, 71, 87, 0.05);
        border: 1px dashed rgba(255, 71, 87, 0.3);
        border-radius: 12px;
        padding: 20px;
        margin: 20px auto 30px;
        max-width: 300px;
      }
      .verification-code {
        font-size: 42px;
        font-weight: 700;
        letter-spacing: 10px;
        color: #ff4757;
        margin: 0;
        text-shadow: 1px 1px 2px rgba(0,0,0,0.05);
      }
      .email-footer {
        text-align: center;
        padding: 30px;
        font-size: 13px;
        color: #888;
        background-color: #f9fafb;
        border-top: 1px solid #eaeaea;
      }
      .social-icons a {
        margin: 0 10px;
        display: inline-block;
      }
      .social-icons a {
        text-decoration: none;
        color: #ff4757;
        font-weight: 600;
        font-size: 14px;
        transition: color 0.3s ease;
      }
      .social-icons a:hover {
        color: #ff6b6b;
      }
    </style>
  </head>
  <body>
    <div class="email-wrapper">
      <div class="email-container">
        <div class="email-header">
          <h1>Asset Insight</h1>
        </div>
        <div class="email-body">
          <div style="font-size: 48px; margin-bottom: 20px;">🔒</div>
          <h2>Confirm Your Identity</h2>
          <p>To keep your account safe, please use the following code to verify your email address. This code is valid for the next 10 minutes.</p>
          <a href="#" class="reset-button">${code}</a>
          <p>If you didn't request this, you can safely ignore this email. Your account is still secure.</p>
        </div>
        <div class="email-footer">
          <p style="margin-top: 20px;">&copy; ${new Date().getFullYear()} Asset Insight. All Rights Reserved.</p>
        </div>
      </div>
    </div>
  </body>
  </html>
  `;
}

export function getPasswordResetCodeEmailHtml(code: string): string {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your Asset Insight Password Reset Code</title>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
      body {
        margin: 0;
        padding: 0;
        font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        background-color: #f4f7fa;
        color: #333;
      }
      .email-wrapper {
        padding: 20px;
        background-color: #f4f7fa;
      }
      .email-container {
        max-width: 600px;
        margin: 0 auto;
        background-color: #ffffff;
        border-radius: 16px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.08);
        overflow: hidden;
      }
      .email-header {
        background: linear-gradient(135deg, #2563eb, #0ea5e9);
        padding: 40px 20px;
        text-align: center;
      }
      .email-header h1 {
        margin: 0;
        font-size: 32px;
        font-weight: 700;
        color: #ffffff;
      }
      .email-body {
        padding: 40px 30px;
        text-align: center;
      }
      .email-body h2 {
        font-size: 24px;
        font-weight: 600;
        color: #1c1e21;
        margin-top: 0;
        margin-bottom: 15px;
      }
      .email-body p {
        font-size: 16px;
        line-height: 1.7;
        color: #555;
        margin-bottom: 25px;
      }
      .reset-code-container {
        background-color: rgba(37, 99, 235, 0.06);
        border: 1px dashed rgba(37, 99, 235, 0.3);
        border-radius: 12px;
        padding: 20px;
        margin: 20px auto 30px;
        max-width: 300px;
      }
      .reset-code {
        font-size: 42px;
        font-weight: 700;
        letter-spacing: 10px;
        color: #2563eb;
        margin: 0;
      }
      .email-footer {
        text-align: center;
        padding: 30px;
        font-size: 13px;
        color: #888;
        background-color: #f9fafb;
        border-top: 1px solid #eaeaea;
      }
    </style>
  </head>
  <body>
    <div class="email-wrapper">
      <div class="email-container">
        <div class="email-header">
          <h1>Asset Insight</h1>
        </div>
        <div class="email-body">
          <div style="font-size: 48px; margin-bottom: 20px;">🔐</div>
          <h2>Reset Your Password</h2>
          <p>Use the following 6-digit code to reset your password. This code is valid for the next 10 minutes.</p>
          <div class="reset-code-container">
            <p class="reset-code">${code}</p>
          </div>
          <p>If you didn't request this password reset, you can safely ignore this email.</p>
        </div>
        <div class="email-footer">
          <p style="margin-top: 20px;">&copy; ${new Date().getFullYear()} Asset Insight. All Rights Reserved.</p>
        </div>
      </div>
    </div>
  </body>
  </html>
  `;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateForEmail(value?: Date | string): string {
  if (!value) return "No due date";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "No due date";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function getCrmAgentAssignedEmailHtml(input: {
  userName?: string;
  crmUrl: string;
}): string {
  const name = escapeHtml(input.userName || "there");
  const crmUrl = escapeHtml(input.crmUrl);

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CRM Access Enabled</title>
  </head>
  <body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,sans-serif;color:#111827;">
    <div style="max-width:600px;margin:20px auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E5E7EB;">
      <div style="background:#0F766E;padding:24px 20px;text-align:center;">
        <h1 style="margin:0;color:#ffffff;font-size:26px;">CRM Access Enabled</h1>
      </div>
      <div style="padding:24px 20px;">
        <p style="font-size:15px;line-height:1.6;margin:0 0 14px;">Hi ${name},</p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 14px;">
          You have been assigned as a CRM agent in Asset Insight. You can now open CRM mode and manage your assigned leads.
        </p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 20px;">
          Start by opening the app and choosing <strong>CRM</strong> from the entry screen.
        </p>
        <div style="text-align:center;margin:22px 0;">
          <a href="${crmUrl}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#0F766E;color:#ffffff;text-decoration:none;font-weight:bold;">Open CRM</a>
        </div>
      </div>
      <div style="padding:14px 20px;background:#F9FAFB;color:#6B7280;font-size:12px;text-align:center;">
        © ${new Date().getFullYear()} Asset Insight
      </div>
    </div>
  </body>
  </html>
  `;
}

export function getCrmTaskAssignedEmailHtml(input: {
  userName?: string;
  taskCount: number;
  crmUrl: string;
  tasks: Array<{ title: string; clientName: string; dueDate?: Date | string }>;
}): string {
  const name = escapeHtml(input.userName || "there");
  const crmUrl = escapeHtml(input.crmUrl);

  const listHtml = input.tasks
    .slice(0, 8)
    .map((task) => {
      const title = escapeHtml(task.title || "CRM Follow-up");
      const client = escapeHtml(task.clientName || "Unknown client");
      const due = escapeHtml(formatDateForEmail(task.dueDate));
      return `<li style="margin-bottom:8px;"><strong>${title}</strong> - ${client} (Due: ${due})</li>`;
    })
    .join("");

  const remaining = Math.max(0, input.taskCount - Math.min(input.taskCount, 8));

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>New CRM Tasks Assigned</title>
  </head>
  <body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,sans-serif;color:#111827;">
    <div style="max-width:640px;margin:20px auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E5E7EB;">
      <div style="background:#1D4ED8;padding:24px 20px;text-align:center;">
        <h1 style="margin:0;color:#ffffff;font-size:25px;">New CRM Tasks Assigned</h1>
      </div>
      <div style="padding:24px 20px;">
        <p style="font-size:15px;line-height:1.6;margin:0 0 12px;">Hi ${name},</p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
          You have <strong>${input.taskCount}</strong> new CRM task${input.taskCount === 1 ? "" : "s"} assigned.
        </p>
        <ul style="margin:0 0 16px 18px;padding:0;font-size:14px;line-height:1.6;">${listHtml}</ul>
        ${remaining > 0 ? `<p style="font-size:14px;color:#6B7280;margin:0 0 14px;">+ ${remaining} more task(s)</p>` : ""}
        <div style="text-align:center;margin:24px 0 8px;">
          <a href="${crmUrl}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#1D4ED8;color:#ffffff;text-decoration:none;font-weight:bold;">Open CRM Tasks</a>
        </div>
      </div>
      <div style="padding:14px 20px;background:#F9FAFB;color:#6B7280;font-size:12px;text-align:center;">
        © ${new Date().getFullYear()} Asset Insight
      </div>
    </div>
  </body>
  </html>
  `;
}

export function getCrmTaskDigestEmailHtml(input: {
  userName?: string;
  crmUrl: string;
  unfinishedCount: number;
  overdueCount: number;
  dueSoonCount: number;
  tasks: Array<{ title: string; clientName: string; status: string; dueDate?: Date | string }>;
}): string {
  const name = escapeHtml(input.userName || "there");
  const crmUrl = escapeHtml(input.crmUrl);

  const listHtml = input.tasks
    .slice(0, 10)
    .map((task) => {
      const title = escapeHtml(task.title || "CRM Follow-up");
      const client = escapeHtml(task.clientName || "Unknown client");
      const status = escapeHtml(String(task.status || "pending").replace(/_/g, " "));
      const due = escapeHtml(formatDateForEmail(task.dueDate));
      return `<tr>
        <td style="padding:8px 6px;border-bottom:1px solid #E5E7EB;">${title}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #E5E7EB;">${client}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #E5E7EB;text-transform:capitalize;">${status}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #E5E7EB;">${due}</td>
      </tr>`;
    })
    .join("");

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CRM Task Digest</title>
  </head>
  <body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,sans-serif;color:#111827;">
    <div style="max-width:700px;margin:20px auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E5E7EB;">
      <div style="background:#7C3AED;padding:24px 20px;text-align:center;">
        <h1 style="margin:0;color:#ffffff;font-size:25px;">CRM Task Update</h1>
      </div>
      <div style="padding:24px 20px;">
        <p style="font-size:15px;line-height:1.6;margin:0 0 14px;">Hi ${name},</p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
          Here is your latest CRM snapshot:
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
          <span style="background:#EEF2FF;padding:8px 10px;border-radius:8px;font-size:13px;"><strong>Unfinished:</strong> ${input.unfinishedCount}</span>
          <span style="background:#FEF2F2;padding:8px 10px;border-radius:8px;font-size:13px;"><strong>Overdue:</strong> ${input.overdueCount}</span>
          <span style="background:#FFFBEB;padding:8px 10px;border-radius:8px;font-size:13px;"><strong>Due Soon:</strong> ${input.dueSoonCount}</span>
        </div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;">
          <thead>
            <tr>
              <th align="left" style="padding:8px 6px;background:#F9FAFB;border-bottom:1px solid #E5E7EB;">Task</th>
              <th align="left" style="padding:8px 6px;background:#F9FAFB;border-bottom:1px solid #E5E7EB;">Client</th>
              <th align="left" style="padding:8px 6px;background:#F9FAFB;border-bottom:1px solid #E5E7EB;">Status</th>
              <th align="left" style="padding:8px 6px;background:#F9FAFB;border-bottom:1px solid #E5E7EB;">Due</th>
            </tr>
          </thead>
          <tbody>
            ${listHtml}
          </tbody>
        </table>
        <div style="text-align:center;margin:24px 0 8px;">
          <a href="${crmUrl}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#7C3AED;color:#ffffff;text-decoration:none;font-weight:bold;">Open CRM</a>
        </div>
      </div>
      <div style="padding:14px 20px;background:#F9FAFB;color:#6B7280;font-size:12px;text-align:center;">
        © ${new Date().getFullYear()} Asset Insight
      </div>
    </div>
  </body>
  </html>
  `;
}

export function getPasswordResetEmailHtml(resetLink: string): string {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your Asset Insight Password Reset</title>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
      body {
        margin: 0;
        padding: 0;
        font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        background-color: #f4f7fa;
        color: #333;
      }
      .email-wrapper {
        padding: 20px;
        background-color: #f4f7fa;
      }
      .email-container {
        max-width: 600px;
        margin: 0 auto;
        background-color: #ffffff;
        border-radius: 16px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.08);
        overflow: hidden;
      }
      .email-header {
        background: linear-gradient(135deg, #ff6b6b, #ff4757);
        padding: 40px 20px;
        text-align: center;
      }
      .email-header h1 {
        margin: 0;
        font-size: 32px;
        font-weight: 700;
        color: #ffffff;
        text-shadow: 1px 1px 3px rgba(0,0,0,0.1);
      }
      .email-body {
        padding: 40px 30px;
        text-align: center;
      }

      .email-body h2 {
        font-size: 24px;
        font-weight: 600;
        color: #1c1e21;
        margin-top: 0;
        margin-bottom: 15px;
      }
      .email-body p {
        font-size: 16px;
        line-height: 1.7;
        color: #555;
        margin-bottom: 25px;
      }
      .reset-button {
        display: inline-block;
        padding: 15px 35px;
        font-size: 16px;
        font-weight: 600;
        color: #ffffff;
        background: linear-gradient(135deg, #ff6b6b, #ff4757);
        border-radius: 50px;
        text-decoration: none;
        margin-top: 20px;
        margin-bottom: 30px;
        box-shadow: 0 5px 15px rgba(255, 71, 87, 0.4);
        transition: all 0.3s ease;
      }
      .reset-button:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 20px rgba(255, 71, 87, 0.5);
      }
      .email-footer {
        text-align: center;
        padding: 30px;
        font-size: 13px;
        color: #888;
        background-color: #f9fafb;
        border-top: 1px solid #eaeaea;
      }
      .social-icons a {
        margin: 0 10px;
        display: inline-block;
      }
      .social-icons a {
        text-decoration: none;
        color: #ff4757;
        font-weight: 600;
        font-size: 14px;
        transition: color 0.3s ease;
      }
      .social-icons a:hover {
        color: #ff6b6b;
      }
    </style>
  </head>
  <body>
    <div class="email-wrapper">
      <div class="email-container">
        <div class="email-header">
          <h1>Asset Insight</h1>
        </div>
        <div class="email-body">
          <div style="font-size: 48px; margin-bottom: 20px;">🔑</div>
          <h2>Reset Your Password</h2>
          <p>We received a request to reset your password. Click the button below to set a new one. This link is valid for the next 10 minutes.</p>
          <a href="${resetLink}" class="reset-button">Reset Your Password</a>
          <p>If you didn't request this, you can safely ignore this email. Your account is still secure.</p>
        </div>
        <div class="email-footer">
          <p style="margin-top: 20px;">&copy; ${new Date().getFullYear()} Asset Insight. All Rights Reserved.</p>
        </div>
      </div>
    </div>
  </body>
  </html>
  `;
}
