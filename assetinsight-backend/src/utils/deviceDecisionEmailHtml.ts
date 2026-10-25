export interface DeviceDecisionEmailInput {
  approved: boolean;
  deviceName: string;
  reason?: string;
  supportName?: string;
  supportEmail?: string;
  supportPhone?: string;
  webAppUrl?: string;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function webDeviceAccessUrl(configuredValue?: string) {
  const fallback = "https://assetinsightvaluator.com";
  const configured = String(configuredValue || fallback).trim();

  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") return `${fallback}/device-access`;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/device-access`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return `${fallback}/device-access`;
  }
}

function supportContactHtml(input: DeviceDecisionEmailInput) {
  const items: string[] = [];

  if (input.supportName) {
    items.push(escapeHtml(input.supportName));
  }

  if (input.supportEmail) {
    const email = escapeHtml(input.supportEmail);
    items.push(
      `<a href="mailto:${email}" style="color:#d71920;text-decoration:none;font-weight:700;">${email}</a>`
    );
  }

  if (input.supportPhone) {
    const label = escapeHtml(input.supportPhone);
    const dialValue = escapeHtml(input.supportPhone.replace(/[^\d+]/g, ""));
    items.push(
      `<a href="tel:${dialValue}" style="color:#d71920;text-decoration:none;font-weight:700;">${label}</a>`
    );
  }

  return items.length > 0
    ? items.join('<span style="color:#b0b4ba;"> &nbsp;&middot;&nbsp; </span>')
    : "Contact your Asset Insight administrator.";
}

export function getDeviceDecisionEmailHtml(input: DeviceDecisionEmailInput) {
  const approved = input.approved;
  const deviceName = escapeHtml(input.deviceName || "Unknown device");
  const accessUrl = escapeHtml(webDeviceAccessUrl(input.webAppUrl));
  const year = new Date().getFullYear();
  const statusColor = approved ? "#16844a" : "#c5221f";
  const statusBackground = approved ? "#eaf8f0" : "#fff0ef";
  const statusSymbol = approved ? "&#10003;" : "&#10005;";
  const title = approved ? "Device approved" : "Device request rejected";
  const subtitle = approved
    ? "Your device is ready to use"
    : "This device has not been approved";
  const intro = approved
    ? "You can now return to Asset Insight and continue securely."
    : "Access remains locked on this device. You can request access again from the device or contact support for help.";
  const buttonLabel = approved ? "Open Asset Insight" : "Review device access";
  const preheader = approved
    ? "Your Asset Insight device is approved and ready to use."
    : "Your Asset Insight device request was not approved.";
  const reason = input.reason
    ? `
      <tr>
        <td style="padding:0 40px 24px;" class="mobile-pad">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;background:#f7f8fa;border:1px solid #e5e7eb;border-radius:10px;">
            <tr>
              <td style="padding:16px 18px;">
                <p style="margin:0 0 5px;color:#60646c;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;line-height:18px;letter-spacing:.04em;text-transform:uppercase;">Administrator note</p>
                <p style="margin:0;color:#272a2f;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:23px;">${escapeHtml(input.reason)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light only">
    <meta name="supported-color-schemes" content="light only">
    <title>${title}</title>
    <style>
      @media only screen and (max-width: 620px) {
        .email-shell { width: 100% !important; }
        .mobile-pad { padding-left: 22px !important; padding-right: 22px !important; }
        .mobile-title { font-size: 28px !important; line-height: 34px !important; }
        .device-label {
          display: block !important;
          width: auto !important;
          border-right: 0 !important;
          border-bottom: 1px solid #dde1e5 !important;
          border-radius: 9px 9px 0 0 !important;
          padding: 12px 16px !important;
        }
        .device-value {
          display: block !important;
          width: auto !important;
          border-radius: 0 0 9px 9px !important;
          padding: 14px 16px !important;
        }
        .full-button { width: 100% !important; }
        .full-button a { display: block !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#f3f5f7;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;background:#f3f5f7;">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" class="email-shell" style="width:600px;max-width:600px;border-collapse:separate;background:#ffffff;border:1px solid #e1e4e8;border-radius:16px;box-shadow:0 8px 24px rgba(27,31,36,.06);overflow:hidden;">
            <tr>
              <td style="padding:24px 40px;border-bottom:1px solid #e8eaed;" class="mobile-pad">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td width="38" height="38" align="center" valign="middle" style="width:38px;height:38px;background:#e31b23;border-radius:9px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:800;line-height:38px;">AI</td>
                    <td style="padding-left:13px;color:#202328;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:800;line-height:26px;">Asset Insight</td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:42px 40px 18px;" class="mobile-pad">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td width="64" height="64" align="center" valign="middle" style="width:64px;height:64px;border:2px solid ${statusColor};border-radius:50%;background:${statusBackground};color:${statusColor};font-family:Arial,Helvetica,sans-serif;font-size:32px;font-weight:700;line-height:60px;">${statusSymbol}</td>
                  </tr>
                </table>
                <h1 class="mobile-title" style="margin:22px 0 8px;color:#1d2025;font-family:Arial,Helvetica,sans-serif;font-size:32px;font-weight:800;line-height:38px;letter-spacing:-.5px;">${title}</h1>
                <p style="margin:0;color:#60646c;font-family:Arial,Helvetica,sans-serif;font-size:17px;line-height:26px;">${subtitle}</p>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 40px 24px;" class="mobile-pad">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:separate;border:1px solid #dde1e5;border-radius:10px;background:#ffffff;">
                  <tr>
                    <td width="120" class="device-label" style="width:120px;padding:17px 18px;background:#f7f8fa;border-right:1px solid #dde1e5;border-radius:9px 0 0 9px;color:#666b73;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;line-height:20px;">Device</td>
                    <td class="device-value" style="padding:17px 18px;color:#202328;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;line-height:22px;word-break:break-word;">${deviceName}</td>
                  </tr>
                </table>
              </td>
            </tr>

            ${reason}

            <tr>
              <td align="center" style="padding:4px 40px 34px;" class="mobile-pad">
                <p style="margin:0 0 22px;color:#3f434a;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:25px;">${intro}</p>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" class="full-button" style="border-collapse:separate;">
                  <tr>
                    <td align="center" bgcolor="#e31b23" style="border-radius:8px;mso-padding-alt:14px 28px;">
                      <a href="${accessUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:800;line-height:20px;text-decoration:none;">${buttonLabel}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 40px;" class="mobile-pad">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:separate;background:#f7f8fa;border-radius:10px;">
                  <tr>
                    <td width="36" valign="top" style="padding:18px 0 18px 18px;color:#30343a;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:800;line-height:24px;">&#128274;</td>
                    <td style="padding:17px 18px 17px 10px;">
                      <p style="margin:0 0 4px;color:#30343a;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:800;line-height:20px;">Security notice</p>
                      <p style="margin:0;color:#60646c;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;">If you did not request access for this device, contact support immediately.</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:26px 40px 32px;" class="mobile-pad">
                <p style="margin:0 0 8px;color:#60646c;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;">Need help?</p>
                <p style="margin:0;color:#30343a;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:21px;">${supportContactHtml(input)}</p>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:20px 32px;background:#f7f8fa;border-top:1px solid #e8eaed;color:#7a7f87;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;">
                &copy; ${year} Asset Insight &nbsp;&middot;&nbsp; Secure device access
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
