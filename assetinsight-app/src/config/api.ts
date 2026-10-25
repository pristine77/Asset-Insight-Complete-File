export const DEFAULT_API_BASE_URL = 'https://api.assetinsightvaluator.com/api';

export function resolveApiBaseUrl(override?: string): string {
  const value = override?.trim();
  if (!value) return DEFAULT_API_BASE_URL;

  // Parse this small public configuration format consistently in Hermes and Node.
  // Credentials, query strings, fragments, whitespace and backslashes are not valid bases.
  const match = /^(https?):\/\/(\[::1\]|[a-z\d.-]+)(?::(\d{1,5}))?(\/[^\s?#\\]*)?$/i.exec(value);
  const invalidConfig = () =>
    new Error(
      'Invalid EXPO_PUBLIC_API_BASE_URL: use an HTTPS API URL, or HTTP for a local development host.'
    );
  if (!match) throw invalidConfig();

  const [, scheme, rawHost, port, pathname = ''] = match;
  const host = rawHost.toLowerCase();
  const octets = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split('.').map(Number) : null;
  const validIpv4 = octets !== null && octets.every((octet) => octet >= 0 && octet <= 255);
  const validHostname =
    host === '[::1]' ||
    (!/^[\d.]+$/.test(host) &&
      host.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)));
  if ((!validIpv4 && !validHostname) || (port && (Number(port) < 1 || Number(port) > 65535))) {
    throw invalidConfig();
  }

  const localHost =
    host === 'localhost' ||
    host === '[::1]' ||
    (validIpv4 &&
      octets !== null &&
      (octets[0] === 127 ||
        octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)));
  if (scheme.toLowerCase() === 'http' && !localHost) throw invalidConfig();

  return `${scheme.toLowerCase()}://${host}${port ? `:${port}` : ''}${pathname}`.replace(
    /\/+$/,
    ''
  );
}

// Expo only inlines literal dot-notation EXPO_PUBLIC_* references. This is public,
// bundled configuration: never put credentials or private keys in this variable.
export const API_BASE_URL = resolveApiBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL);

export const API_ENDPOINTS = {
  LOGIN: '/auth/login',
  SIGNUP: '/auth/signup',
  REFRESH_TOKEN: '/auth/refresh-token',
  LOGOUT: '/auth/logout',
  VERIFY_EMAIL: '/auth/verify-email',
  RESEND_VERIFICATION_CODE: '/auth/resend-verification-code',
  FORGOT_PASSWORD: '/auth/forgot-password',
  RESET_PASSWORD_CODE: '/auth/reset-password-code',
  RESET_PASSWORD: '/auth/reset-password',
  ME: '/user/me',
  // Asset endpoints
  CREATE_ASSET: '/asset',
  GET_ASSETS: '/asset',
  GET_ASSET_PROGRESS: '/asset/progress',
  GET_PREVIEW: '/asset',
  UPDATE_PREVIEW: '/asset',
  SUBMIT_PREVIEW: '/asset',
  // Real Estate endpoints
  GET_REAL_ESTATE_PREVIEW: '/real-estate/preview',
  UPDATE_REAL_ESTATE_PREVIEW: '/real-estate/preview',
  SUBMIT_REAL_ESTATE_PREVIEW: '/real-estate/preview',
  // Lot Listing endpoints
  CREATE_LOT_LISTING: '/lot-listing',
  GET_LOT_LISTINGS: '/lot-listing',
  GET_LOT_LISTING_PROGRESS: '/lot-listing/progress',
  // CRM endpoints
  CRM_MY_TASKS: '/crm/tasks/my',
  CRM_FOLLOW_UPS: '/crm/tasks/follow-ups',
  CRM_TASKS_QUICK_ADD: '/crm/tasks/quick-add',
  CRM_TASKS: '/crm/tasks',
  CRM_TASK_COMMENT_TRANSCRIBE: '/crm/tasks/comment/transcribe',
  CRM_EMAIL_REWRITE: '/crm/tasks/email/rewrite',
  CRM_OUTLOOK_STATUS: '/crm/calendar/ms/outlook/status',
  CRM_OUTLOOK_AUTH_URL: '/crm/calendar/ms/outlook/auth-url',
  CRM_OUTLOOK_DISCONNECT: '/crm/calendar/ms/outlook/disconnect',
  CRM_OUTLOOK_BULK_ADD: '/crm/tasks/calendar/ms/outlook/bulk',
  CRM_TRANSFER_AGENTS: '/crm/tasks/transfer/agents',
  CRM_TRANSFER_INBOX: '/crm/tasks/transfers/my',
};
