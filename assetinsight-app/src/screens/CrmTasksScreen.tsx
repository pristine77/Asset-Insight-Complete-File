import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  Alert,
  Linking,
  Modal,
  Platform,
  Image,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Feather, FontAwesome } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { ensurePhotoPickerAccess } from '../utils/photoPickerAccess';
import { Audio } from 'expo-av';
import * as MailComposer from 'expo-mail-composer';
import { WebView } from 'react-native-webview';
import crmTaskApi, {
  CRM_LOST_REASONS,
  CRM_LOST_REASON_LABELS,
  CRM_OPEN_STATUSES,
  CRM_SPECIALIZATION_OPTIONS,
  CRM_STATUS_LABELS,
  CRM_STATUSES,
  CrmLostReason,
  CrmOutlookCalendarStatus,
  CrmSpecializationValue,
  CrmTaskItem,
  CrmTaskStatus,
  CrmTaskTransferItem,
  CrmTaskUpdateEntry,
  CrmTransferAgent,
  UploadableFile,
} from '../services/crmService';
import type { CrmDashboardTaskFilter } from '../services/crmService';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import CrmModalFrame, { crmTouchTarget } from '../components/crm/CrmModalFrame';
import CrmFollowUpPicker from '../components/crm/CrmFollowUpPicker';
import {
  deviceTimeZone,
  followUpChange,
  type FollowUpDraft,
  followUpReminderSentFor,
  followUpReminderText,
  formatFollowUp,
  initialFollowUpDraft,
  isFollowUpPast,
} from '../services/crmFollowUp';

interface CrmTasksScreenProps {
  onOpenDrawer: () => void;
  onBack: () => void;
  initialTaskId?: string | null;
  initialDashboardFilter?: CrmDashboardTaskFilter | null;
  initialStatusFilter?: CrmTaskStatus | null;
  onClearInitialTask?: () => void;
  onClearInitialDashboardFilter?: () => void;
  onClearInitialStatusFilter?: () => void;
}

type FetchTasksOptions = {
  statusFilterOverride?: 'all' | CrmTaskStatus;
  dashboardFilterOverride?: CrmDashboardTaskFilter | null;
  searchTextOverride?: string;
};

const STATUS_OPTIONS: { key: 'all' | CrmTaskStatus; label: string; compactLabel?: string }[] = [
  { key: 'all', label: 'All Open' },
  { key: 'new_lead', label: 'New Lead' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'inspection_required', label: 'Inspection Required', compactLabel: 'Inspect Req.' },
  { key: 'inspection_complete', label: 'Inspection Complete', compactLabel: 'Inspect Done' },
  { key: 'proposal_submitted', label: 'Proposal Submitted', compactLabel: 'Proposal' },
  { key: 'decision_pending', label: 'Decision Pending', compactLabel: 'Decision' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
];

const STATUS_FILTER_COLORS: Record<
  'all' | CrmTaskStatus,
  { bg: string; border: string; text: string; activeBg: string; activeText: string; shadow: string }
> = {
  all: {
    bg: 'rgba(254, 243, 199, 0.86)',
    border: 'rgba(251, 191, 36, 0.78)',
    text: '#713F12',
    activeBg: '#FBBF24',
    activeText: '#0C4A6E',
    shadow: '#B45309',
  },
  new_lead: {
    bg: 'rgba(224, 242, 254, 0.82)',
    border: 'rgba(14, 165, 233, 0.55)',
    text: '#075985',
    activeBg: '#0EA5E9',
    activeText: '#FFFFFF',
    shadow: '#0369A1',
  },
  contacted: {
    bg: 'rgba(219, 234, 254, 0.82)',
    border: 'rgba(37, 99, 235, 0.52)',
    text: '#1D4ED8',
    activeBg: '#2563EB',
    activeText: '#FFFFFF',
    shadow: '#1E40AF',
  },
  inspection_required: {
    bg: 'rgba(254, 215, 170, 0.84)',
    border: 'rgba(249, 115, 22, 0.56)',
    text: '#9A3412',
    activeBg: '#F97316',
    activeText: '#FFFFFF',
    shadow: '#C2410C',
  },
  inspection_complete: {
    bg: 'rgba(224, 231, 255, 0.84)',
    border: 'rgba(99, 102, 241, 0.54)',
    text: '#4338CA',
    activeBg: '#6366F1',
    activeText: '#FFFFFF',
    shadow: '#4338CA',
  },
  proposal_submitted: {
    bg: 'rgba(252, 231, 243, 0.86)',
    border: 'rgba(236, 72, 153, 0.48)',
    text: '#BE185D',
    activeBg: '#EC4899',
    activeText: '#FFFFFF',
    shadow: '#BE185D',
  },
  decision_pending: {
    bg: 'rgba(237, 233, 254, 0.86)',
    border: 'rgba(124, 58, 237, 0.5)',
    text: '#6D28D9',
    activeBg: '#7C3AED',
    activeText: '#FFFFFF',
    shadow: '#5B21B6',
  },
  won: {
    bg: 'rgba(220, 252, 231, 0.86)',
    border: 'rgba(22, 163, 74, 0.52)',
    text: '#15803D',
    activeBg: '#16A34A',
    activeText: '#FFFFFF',
    shadow: '#166534',
  },
  lost: {
    bg: 'rgba(254, 226, 226, 0.88)',
    border: 'rgba(239, 68, 68, 0.58)',
    text: '#B91C1C',
    activeBg: '#EF4444',
    activeText: '#FFFFFF',
    shadow: '#B91C1C',
  },
};

const LOST_REASON_OPTIONS = CRM_LOST_REASONS.map((value) => ({
  key: value,
  label: CRM_LOST_REASON_LABELS[value],
}));

const DASHBOARD_FILTER_META: Record<CrmDashboardTaskFilter, { label: string; description: string }> = {
  all: { label: 'Total Leads', description: 'All open CRM leads' },
  generic: { label: 'Generic Leads', description: 'Software/imported CRM leads' },
  organic: { label: 'Organic Leads', description: 'Quick Add CRM leads' },
  upcoming: { label: 'Upcoming', description: 'Open leads due in the next 7 days' },
  overdue: { label: 'Overdue', description: 'Open leads past due date' },
};

const CRM_QUADRANT_OPTIONS = [
  { value: 'NW', label: 'North West' },
  { value: 'NE', label: 'North East' },
  { value: 'SW', label: 'South West' },
  { value: 'SE', label: 'South East' },
  { value: 'NORTH', label: 'North' },
  { value: 'SOUTH', label: 'South' },
  { value: 'EAST', label: 'East' },
  { value: 'WEST', label: 'West' },
  { value: 'CENTRAL', label: 'Central' },
] as const;

function specializationLabel(value?: string): string {
  return CRM_SPECIALIZATION_OPTIONS.find((option) => option.value === value)?.label || '';
}

function specializationLabels(values?: string[]): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => specializationLabel(value)).filter(Boolean);
}

function parseCrmQuadrants(value?: string): string[] {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function formatDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return date.toLocaleDateString();
}

function getDefaultQuickAddDueDate(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(17, 0, 0, 0);
  return date;
}

function formatQuickAddDueDate(value: Date): string {
  return value.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function statusText(status: CrmTaskStatus): string {
  return CRM_STATUS_LABELS[status] || status;
}

function getStatusBadge(status: CrmTaskStatus) {
  if (status === 'new_lead') return { bg: '#E0F2FE', text: '#075985' };
  if (status === 'contacted') return { bg: '#DBEAFE', text: '#1D4ED8' };
  if (status === 'inspection_required') return { bg: '#FEF3C7', text: '#B45309' };
  if (status === 'inspection_complete') return { bg: '#E0E7FF', text: '#4338CA' };
  if (status === 'proposal_submitted') return { bg: '#FCE7F3', text: '#BE185D' };
  if (status === 'decision_pending') return { bg: '#F3E8FF', text: '#7C3AED' };
  if (status === 'won') return { bg: '#DCFCE7', text: '#166534' };
  return { bg: '#FEE2E2', text: '#B91C1C' };
}

function lostReasonText(reason?: CrmLostReason): string {
  if (!reason) return '';
  return CRM_LOST_REASON_LABELS[reason] || reason;
}

function autoReminderText(status: CrmTaskStatus, lostReason?: CrmLostReason | ''): string {
  if (status === 'contacted' || status === 'inspection_required' || status === 'inspection_complete') {
    return 'Automatic reminder every 7 days if this status does not change.';
  }
  if (status === 'proposal_submitted' || status === 'decision_pending') {
    return 'Automatic reminder every 2 days if this status does not change.';
  }
  if (status === 'lost') {
    if (lostReason === 'competitor') {
      return 'Competitor closes the lead with no automatic reminder.';
    }
    return 'Lost leads with this reason get an automatic reminder every 30 days.';
  }
  if (status === 'won') {
    return 'Won closes the lead and removes automatic reminders.';
  }
  return 'New leads do not get an automatic reminder until the status moves forward.';
}

function listLabel(items?: string[]): string {
  if (!Array.isArray(items) || items.length === 0) return '-';
  return items.join(', ');
}

type CallOption = {
  label: string;
  value: string;
};

const PHONE_PLACEHOLDER_PATTERN = /^(?:researching(?:\.{3})?|pending|unknown|n\/?a|none|not\s+(?:available|found|provided)|no\s+(?:phone|number)|tbd|-+)$/i;

function parseDialablePhone(value?: string): { display: string; dial: string; identity: string } | null {
  const raw = String(value || '').trim();
  if (!raw || PHONE_PLACEHOLDER_PATTERN.test(raw)) return null;

  const extensionMatch = raw.match(/(?:ext\.?|extension|x)\s*(\d{1,8})\s*$/i);
  const extension = extensionMatch?.[1] || '';
  const main = extensionMatch ? raw.slice(0, extensionMatch.index).trim() : raw;
  const digits = main.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  const identityDigits = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;

  const dial = `${main.trim().startsWith('+') ? '+' : ''}${digits}${extension ? `,${extension}` : ''}`;
  return {
    display: raw,
    dial,
    identity: `${identityDigits}${extension ? `x${extension}` : ''}`,
  };
}

function hasAnyCallNumber(task: CrmTaskItem): boolean {
  return buildCallOptions(task).length > 0;
}

function buildCallOptions(task: CrmTaskItem): CallOption[] {
  const options: CallOption[] = [];
  const seen = new Set<string>();

  const push = (label: string, value?: string) => {
    const parsed = parseDialablePhone(value);
    if (!parsed || seen.has(parsed.identity)) return;
    seen.add(parsed.identity);
    options.push({ label, value: parsed.display });
  };

  // Check both fields independently: an older record can contain a placeholder
  // formatted value while retaining a valid raw primary number.
  push('Primary', task.phoneFormatted);
  push('Primary', task.phoneRaw);
  (task.contactPhones || []).forEach((phone, index) => push(`Contact Phone ${index + 1}`, phone));
  (task.contactMobilePhones || []).forEach((phone, index) =>
    push(`Contact Mobile ${index + 1}`, phone)
  );
  (task.companyPhones || []).forEach((phone, index) => push(`Company Phone ${index + 1}`, phone));

  return options;
}

function formatNumberValue(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return value.toLocaleString();
}

function toReadableImportFieldLabel(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatImportFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (Array.isArray(value)) {
    const mapped = value.map((item) => String(item || '').trim()).filter(Boolean);
    return mapped.length > 0 ? mapped.join(', ') : '-';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '-';
    }
  }
  const text = String(value).trim();
  if (!text) return '-';

  const asDate = new Date(text);
  if (Number.isFinite(asDate.getTime()) && /\d{4}-\d{2}-\d{2}|\d{4}\/\d{2}\/\d{2}/.test(text)) {
    return asDate.toLocaleDateString();
  }

  return text;
}

type SocialPlatform =
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'twitter'
  | 'youtube'
  | 'tiktok'
  | 'website';

type SocialLinkItem = {
  platform: SocialPlatform;
  label: string;
  url: string;
};

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(Math.floor(ms / 1000), 0);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function ensureAbsoluteUrl(value?: string): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^www\./i.test(raw)) return `https://${raw}`;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(raw)) return `https://${raw}`;
  return null;
}

function inferSocialPlatform(url: string): SocialPlatform {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes('facebook')) return 'facebook';
    if (hostname.includes('instagram')) return 'instagram';
    if (hostname.includes('linkedin')) return 'linkedin';
    if (hostname.includes('twitter') || hostname.includes('x.com')) return 'twitter';
    if (hostname.includes('youtube') || hostname.includes('youtu.be')) return 'youtube';
    if (hostname.includes('tiktok')) return 'tiktok';
  } catch {
    // fallback below
  }
  return 'website';
}

function getSocialIconName(
  platform: SocialPlatform
): React.ComponentProps<typeof FontAwesome>['name'] {
  if (platform === 'facebook') return 'facebook';
  if (platform === 'instagram') return 'instagram';
  if (platform === 'linkedin') return 'linkedin';
  if (platform === 'twitter') return 'twitter';
  if (platform === 'youtube') return 'youtube-play';
  if (platform === 'tiktok') return 'music';
  return 'globe';
}

function buildSocialUrlFromHandle(raw: string): string | null {
  const handleMatch = raw.match(
    /^(facebook|fb|instagram|ig|linkedin|twitter|x|youtube|yt|tiktok)\s*[:\-]?\s*@?([a-z0-9._-]{2,})$/i
  );
  if (!handleMatch) return null;
  const platform = handleMatch[1].toLowerCase();
  const handle = handleMatch[2];

  if (platform === 'facebook' || platform === 'fb') return `https://facebook.com/${handle}`;
  if (platform === 'instagram' || platform === 'ig') return `https://instagram.com/${handle}`;
  if (platform === 'linkedin') return `https://linkedin.com/in/${handle}`;
  if (platform === 'twitter' || platform === 'x') return `https://x.com/${handle}`;
  if (platform === 'youtube' || platform === 'yt') return `https://youtube.com/@${handle}`;
  if (platform === 'tiktok') return `https://www.tiktok.com/@${handle}`;
  return null;
}

function socialLabelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '');
    const path = parsed.pathname.replace(/^\/+/, '').slice(0, 24);
    return path ? `${host}/${path}` : host;
  } catch {
    return url;
  }
}

function parseSocialLinks(rawValue?: string): SocialLinkItem[] {
  const raw = String(rawValue || '').trim();
  if (!raw) return [];

  const chunks = raw
    .split(/[\n,;|]+/g)
    .map((v) => v.trim())
    .filter(Boolean);

  const items: SocialLinkItem[] = [];
  const seen = new Set<string>();

  const pushUrl = (candidate: string) => {
    const url = ensureAbsoluteUrl(candidate) || buildSocialUrlFromHandle(candidate);
    if (!url) return;
    const normalized = url.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    items.push({
      platform: inferSocialPlatform(url),
      label: socialLabelFromUrl(url),
      url,
    });
  };

  for (const chunk of chunks) {
    const urlMatches = chunk.match(/(?:https?:\/\/|www\.)[^\s]+/gi);
    if (urlMatches?.length) {
      for (const matched of urlMatches) pushUrl(matched);
      continue;
    }
    pushUrl(chunk);
  }

  return items;
}

function guessAudioMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'ogg') return 'audio/ogg';
  if (ext === 'webm') return 'audio/webm';
  if (ext === 'aac') return 'audio/aac';
  if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
  return 'audio/m4a';
}

function formatDateTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return date.toLocaleString();
}

function isLikelyImageAttachment(url?: string): boolean {
  const clean = String(url || '')
    .trim()
    .split('?')[0]
    .toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif|svg)$/i.test(clean);
}

function normalizeUpdateId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const maybeOid = String((value as any).$oid || '').trim();
    if (maybeOid) return maybeOid;

    const maybeNested = String((value as any)._id || '').trim();
    if (maybeNested && maybeNested !== '[object Object]') return maybeNested;

    if (typeof (value as any).toHexString === 'function') {
      const maybeHex = String((value as any).toHexString()).trim();
      if (maybeHex) return maybeHex;
    }
  }

  const fallback = String(value || '').trim();
  return fallback === '[object Object]' ? '' : fallback;
}

function updateCreatorLabel(input?: { username?: string; email?: string; role?: string }): string {
  const base = input?.username || input?.email || 'Unknown';
  const role = String(input?.role || '').toLowerCase();
  if (role === 'admin' || role === 'superadmin') return `${base} (Admin)`;
  return `${base} (CRM)`;
}

function crmUserLabel(input?: { username?: string; email?: string }): string {
  return input?.username || input?.email || 'Unknown CRM agent';
}

const CrmTasksScreen = ({
  onOpenDrawer,
  onBack,
  initialTaskId,
  initialDashboardFilter,
  initialStatusFilter,
  onClearInitialTask,
  onClearInitialDashboardFilter,
  onClearInitialStatusFilter,
}: CrmTasksScreenProps) => {
  const { user, refreshUser } = useAuth();
  const { width } = useWindowDimensions();
  const isCompact = width < 380;
  const isVeryCompact = width < 340;
  const [tasks, setTasks] = useState<CrmTaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddName, setQuickAddName] = useState('');
  const [quickAddPhone, setQuickAddPhone] = useState('');
  const [quickAddSpecialization, setQuickAddSpecialization] = useState<CrmSpecializationValue | ''>('');
  const [quickAddDueDate, setQuickAddDueDate] = useState<Date>(() => getDefaultQuickAddDueDate());
  const [showQuickAddDuePicker, setShowQuickAddDuePicker] = useState(false);
  const [quickAddNotes, setQuickAddNotes] = useState('');
  const [quickAdding, setQuickAdding] = useState(false);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const displayName = user?.username || user?.email?.split('@')[0] || 'there';

  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | CrmTaskStatus>(initialStatusFilter || 'all');
  const [dashboardFilter, setDashboardFilter] = useState<CrmDashboardTaskFilter | null>(
    initialDashboardFilter || null
  );

  const [selectedTask, setSelectedTask] = useState<CrmTaskItem | null>(null);
  const [updateModalVisible, setUpdateModalVisible] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<CrmTaskStatus>('new_lead');
  const [updateLostReason, setUpdateLostReason] = useState<CrmLostReason | ''>('');
  const [followUpDraft, setFollowUpDraft] = useState<FollowUpDraft>({ date: null, time: null });
  const [comment, setComment] = useState('');
  const [attachments, setAttachments] = useState<UploadableFile[]>([]);
  const [recording, setRecording] = useState<UploadableFile | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [commentRecording, setCommentRecording] = useState<Audio.Recording | null>(null);
  const [commentRecordingDurationMs, setCommentRecordingDurationMs] = useState(0);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [transcribingComment, setTranscribingComment] = useState(false);
  const [playingRecordingUrl, setPlayingRecordingUrl] = useState<string | null>(null);
  const [recordingPlaybackLoadingUrl, setRecordingPlaybackLoadingUrl] = useState<string | null>(
    null
  );
  const [timelineBusyKey, setTimelineBusyKey] = useState<string | null>(null);
  const [editingUpdateId, setEditingUpdateId] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState('');
  const [editingStatus, setEditingStatus] = useState<CrmTaskStatus>('new_lead');
  const [editingLostReason, setEditingLostReason] = useState<CrmLostReason | ''>('');
  const [callModalVisible, setCallModalVisible] = useState(false);
  const [callTargetTask, setCallTargetTask] = useState<CrmTaskItem | null>(null);
  const [callOptions, setCallOptions] = useState<CallOption[]>([]);
  const [dialingNumber, setDialingNumber] = useState<string | null>(null);
  const [crmProfileModalVisible, setCrmProfileModalVisible] = useState(false);
  const [crmProfileAddress, setCrmProfileAddress] = useState('');
  const [crmProfileQuadrants, setCrmProfileQuadrants] = useState<string[]>([]);
  const [crmProfileSpecializations, setCrmProfileSpecializations] = useState<string[]>([]);
  const [crmProfileSaving, setCrmProfileSaving] = useState(false);
  const [crmProfileCaptured, setCrmProfileCaptured] = useState(false);
  const [sectionContactOpen, setSectionContactOpen] = useState(false);
  const [sectionLocationOpen, setSectionLocationOpen] = useState(false);
  const [sectionCompanyOpen, setSectionCompanyOpen] = useState(false);
  const [sectionImportOpen, setSectionImportOpen] = useState(false);
  const [sectionTimelineOpen, setSectionTimelineOpen] = useState(false);
  const playbackSoundRef = useRef<Audio.Sound | null>(null);

  const [emailModalVisible, setEmailModalVisible] = useState(false);
  const [emailTask, setEmailTask] = useState<CrmTaskItem | null>(null);
  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [emailRecording, setEmailRecording] = useState<Audio.Recording | null>(null);
  const [emailRecordingDurationMs, setEmailRecordingDurationMs] = useState(0);
  const [emailVoiceBusy, setEmailVoiceBusy] = useState(false);
  const [emailTranscribing, setEmailTranscribing] = useState(false);
  const [emailRewriting, setEmailRewriting] = useState(false);
  const [emailIsHtml, setEmailIsHtml] = useState(false);
  const [emailPreviewMode, setEmailPreviewMode] = useState(false);
  const [emailHtmlBody, setEmailHtmlBody] = useState('');
  const [emailClientChooserVisible, setEmailClientChooserVisible] = useState(false);
  const [emailPreparedTo, setEmailPreparedTo] = useState('');
  const [emailPreparedSubject, setEmailPreparedSubject] = useState('');
  const [emailPreparedBody, setEmailPreparedBody] = useState('');
  const [emailPreparedHtmlBody, setEmailPreparedHtmlBody] = useState('');
  const [outlookStatus, setOutlookStatus] = useState<CrmOutlookCalendarStatus>({
    connected: false,
    configured: true,
  });
  const [outlookStatusLoading, setOutlookStatusLoading] = useState(true);
  const [outlookBusy, setOutlookBusy] = useState(false);
  const [outlookSyncingTaskId, setOutlookSyncingTaskId] = useState<string | null>(null);
  const [outlookBulkSyncing, setOutlookBulkSyncing] = useState(false);
  const [calendarSyncModalVisible, setCalendarSyncModalVisible] = useState(false);
  const [calendarSyncSearchText, setCalendarSyncSearchText] = useState('');
  const [calendarSyncStatusFilter, setCalendarSyncStatusFilter] = useState<'all' | CrmTaskStatus>('all');
  const [calendarSyncSelectedTaskIds, setCalendarSyncSelectedTaskIds] = useState<string[]>([]);
  const [transferModalVisible, setTransferModalVisible] = useState(false);
  const [transferInboxVisible, setTransferInboxVisible] = useState(false);
  const [transferTask, setTransferTask] = useState<CrmTaskItem | null>(null);
  const [transferAgents, setTransferAgents] = useState<CrmTransferAgent[]>([]);
  const [transferAgentsLoading, setTransferAgentsLoading] = useState(false);
  const [transferAgentId, setTransferAgentId] = useState('');
  const [transferNote, setTransferNote] = useState('');
  const [transferSubmitting, setTransferSubmitting] = useState(false);
  const [transferInbox, setTransferInbox] = useState<CrmTaskTransferItem[]>([]);
  const [transferInboxLoading, setTransferInboxLoading] = useState(false);
  const [transferRespondingId, setTransferRespondingId] = useState<string | null>(null);

  useEffect(() => {
    setDashboardFilter(initialDashboardFilter || null);
    if (initialDashboardFilter) {
      setStatusFilter('all');
      setSearchText('');
    }
  }, [initialDashboardFilter]);

  useEffect(() => {
    if (!initialStatusFilter) return;
    setDashboardFilter(null);
    setStatusFilter(initialStatusFilter);
    setSearchText('');
    onClearInitialStatusFilter?.();
  }, [initialStatusFilter, onClearInitialStatusFilter]);

  const applyTaskMutationResult = useCallback((item: CrmTaskItem) => {
    if (!item?._id) return;
    setTasks((prev) => {
      const exists = prev.some((task) => task._id === item._id);
      return exists ? prev.map((task) => (task._id === item._id ? item : task)) : [item, ...prev];
    });
    setSelectedTask((prev) => (prev && prev._id === item._id ? item : prev));
    setUpdateStatus(item.status || 'new_lead');
    setUpdateLostReason(item.lostReason || '');
  }, []);

  const beginEditUpdate = (update: CrmTaskUpdateEntry) => {
    const updateId = normalizeUpdateId(update._id);
    if (!updateId) return;
    setEditingUpdateId(updateId);
    setEditingComment(update.comment || '');
    setEditingStatus((update.status || selectedTask?.status || 'new_lead') as CrmTaskStatus);
    setEditingLostReason((update.lostReason || selectedTask?.lostReason || '') as CrmLostReason | '');
  };

  const cancelEditUpdate = () => {
    setEditingUpdateId(null);
    setEditingComment('');
    setEditingLostReason('');
  };

  const saveEditUpdate = async (update: CrmTaskUpdateEntry) => {
    const taskId = selectedTask?._id;
    const updateId = normalizeUpdateId(update?._id);
    if (!taskId || !updateId) return;
    if (editingStatus === 'lost' && !editingLostReason) {
      Alert.alert('Lost Reason Required', 'Please choose a lost reason before saving.');
      return;
    }
    try {
      setTimelineBusyKey(`edit:${updateId}`);
      const item = await crmTaskApi.editTaskUpdate(taskId, updateId, {
        comment: editingComment,
        status: editingStatus,
        lostReason: editingStatus === 'lost' && editingLostReason ? editingLostReason : undefined,
      });
      applyTaskMutationResult(item);
      setEditingUpdateId(null);
      setEditingComment('');
    } catch (e: any) {
      Alert.alert(
        'Edit failed',
        e?.response?.data?.message || e?.message || 'Failed to edit update.'
      );
    } finally {
      setTimelineBusyKey(null);
    }
  };

  const deleteUpdate = async (update: CrmTaskUpdateEntry) => {
    const taskId = selectedTask?._id;
    const updateId = normalizeUpdateId(update?._id);
    if (!taskId || !updateId) return;
    Alert.alert('Delete update', 'This will remove this message and its media.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              setTimelineBusyKey(`delete:${updateId}`);
              const item = await crmTaskApi.deleteTaskUpdate(taskId, updateId);
              applyTaskMutationResult(item);
            } catch (e: any) {
              Alert.alert(
                'Delete failed',
                e?.response?.data?.message || e?.message || 'Failed to delete update.'
              );
            } finally {
              setTimelineBusyKey(null);
            }
          })();
        },
      },
    ]);
  };

  const deleteUpdateAttachment = async (update: CrmTaskUpdateEntry, url: string) => {
    const taskId = selectedTask?._id;
    const updateId = normalizeUpdateId(update?._id);
    if (!taskId || !updateId) return;
    try {
      setTimelineBusyKey(`attachment:${updateId}:${url}`);
      const item = await crmTaskApi.deleteTaskUpdateAttachments(taskId, updateId, [url]);
      applyTaskMutationResult(item);
    } catch (e: any) {
      Alert.alert(
        'Delete failed',
        e?.response?.data?.message || e?.message || 'Failed to delete attachment.'
      );
    } finally {
      setTimelineBusyKey(null);
    }
  };

  const deleteUpdateRecording = async (update: CrmTaskUpdateEntry) => {
    const taskId = selectedTask?._id;
    const updateId = normalizeUpdateId(update?._id);
    if (!taskId || !updateId) return;
    try {
      setTimelineBusyKey(`recording:${updateId}`);
      const item = await crmTaskApi.deleteTaskUpdateRecording(taskId, updateId);
      applyTaskMutationResult(item);
    } catch (e: any) {
      Alert.alert(
        'Delete failed',
        e?.response?.data?.message || e?.message || 'Failed to delete recording.'
      );
    } finally {
      setTimelineBusyKey(null);
    }
  };

  const fetchTasks = useCallback(async (options: FetchTasksOptions = {}) => {
    try {
      setError(null);
      const effectiveDashboardFilter =
        options.dashboardFilterOverride !== undefined ? options.dashboardFilterOverride : dashboardFilter;
      const effectiveStatusFilter = options.statusFilterOverride || statusFilter;
      const effectiveSearchText =
        options.searchTextOverride !== undefined ? options.searchTextOverride : searchText;
      const leadSource =
        effectiveDashboardFilter === 'generic' || effectiveDashboardFilter === 'organic'
          ? effectiveDashboardFilter
          : undefined;
      const due =
        effectiveDashboardFilter === 'upcoming' || effectiveDashboardFilter === 'overdue'
          ? effectiveDashboardFilter
          : undefined;
      const data = await crmTaskApi.getMyTasks({
        q: effectiveSearchText.trim() || undefined,
        status: effectiveStatusFilter === 'all' ? undefined : effectiveStatusFilter,
        leadSource,
        due,
        page: 1,
        limit: 100,
      });
      setTasks(data.items || []);
    } catch (e: any) {
      const message = e?.response?.data?.message || e?.message || 'Failed to load CRM tasks';
      setError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dashboardFilter, searchText, statusFilter]);

  const resetQuickAdd = useCallback(() => {
    setQuickAddName('');
    setQuickAddPhone('');
    setQuickAddSpecialization('');
    setQuickAddDueDate(getDefaultQuickAddDueDate());
    setShowQuickAddDuePicker(false);
    setQuickAddNotes('');
  }, []);

  const handleQuickAddDueDateChange = useCallback((_event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS !== 'ios') {
      setShowQuickAddDuePicker(false);
    }
    if (!selectedDate) return;
    const nextDate = new Date(selectedDate);
    nextDate.setHours(17, 0, 0, 0);
    setQuickAddDueDate(nextDate);
  }, []);

  const submitQuickAdd = useCallback(async () => {
    if (!quickAddName.trim() || !quickAddPhone.trim() || !quickAddSpecialization) {
      Alert.alert('Missing details', 'Name, phone number, and CRM specialization are required.');
      return;
    }

    try {
      setQuickAdding(true);
      await crmTaskApi.quickAddLead({
        name: quickAddName.trim(),
        phone: quickAddPhone.trim(),
        specialization: quickAddSpecialization,
        category: specializationLabel(quickAddSpecialization),
        dueDate: quickAddDueDate.toISOString(),
        notes: quickAddNotes.trim(),
      });
      resetQuickAdd();
      setQuickAddOpen(false);
      await fetchTasks();
      Alert.alert('Lead added', 'Organic quick-add lead created.');
    } catch (e: any) {
      Alert.alert('Quick add failed', e?.response?.data?.message || e?.message || 'Failed to create lead.');
    } finally {
      setQuickAdding(false);
    }
  }, [fetchTasks, quickAddDueDate, quickAddName, quickAddNotes, quickAddPhone, quickAddSpecialization, resetQuickAdd]);

  const fetchOutlookStatus = useCallback(async (showError = false) => {
    try {
      setOutlookStatusLoading(true);
      const status = await crmTaskApi.getOutlookCalendarStatus();
      setOutlookStatus(status);
    } catch (e: any) {
      if (showError) {
        Alert.alert(
          'Outlook Status Error',
          e?.response?.data?.message || e?.message || 'Failed to load Outlook calendar status.'
        );
      }
    } finally {
      setOutlookStatusLoading(false);
    }
  }, []);

  const fetchTransferInbox = useCallback(async (showError = false) => {
    try {
      setTransferInboxLoading(true);
      const items = await crmTaskApi.getMyTransferRequests();
      setTransferInbox(items);
    } catch (e: any) {
      if (showError) {
        Alert.alert(
          'Transfer Inbox Error',
          e?.response?.data?.message || e?.message || 'Failed to load transfer requests.'
        );
      }
    } finally {
      setTransferInboxLoading(false);
    }
  }, []);

  const fetchTransferAgents = useCallback(async (showError = false) => {
    try {
      setTransferAgentsLoading(true);
      const agents = await crmTaskApi.listTransferAgents();
      setTransferAgents(agents);
    } catch (e: any) {
      if (showError) {
        Alert.alert(
          'Transfer Agents Error',
          e?.response?.data?.message || e?.message || 'Failed to load CRM agents.'
        );
      }
    } finally {
      setTransferAgentsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  useEffect(() => {
    void fetchOutlookStatus();
    void fetchTransferInbox();
  }, [fetchOutlookStatus, fetchTransferInbox]);

  useEffect(() => {
    if (!user?.isCrmAgent) {
      setCrmProfileModalVisible(false);
      setCrmProfileCaptured(true);
      return;
    }

    const address = String(user.crmAddress || user.companyAddress || '').trim();
    const quadrants = parseCrmQuadrants(user.crmQuadrant);
    const specializations = Array.isArray(user.crmSpecializations) ? user.crmSpecializations : [];
    const hasProfile = Boolean(address && quadrants.length > 0 && specializations.length > 0);

    if (hasProfile) {
      setCrmProfileCaptured(true);
      setCrmProfileModalVisible(false);
      return;
    }

    if (!crmProfileCaptured) {
      setCrmProfileAddress(address);
      setCrmProfileQuadrants(quadrants);
      setCrmProfileSpecializations(specializations);
      setCrmProfileModalVisible(true);
    }
  }, [
    user?.isCrmAgent,
    user?.crmAddress,
    user?.crmQuadrant,
    user?.crmSpecializations,
    user?.companyAddress,
    crmProfileCaptured,
  ]);

  const handleCrmProfileSpecializationPress = useCallback((value: string) => {
    setCrmProfileSpecializations((prev) => {
      const exists = prev.includes(value);
      return exists ? prev.filter((item) => item !== value) : [...prev, value];
    });
  }, []);

  const handleCrmProfileSpecializationLongPress = useCallback((value: string) => {
    setCrmProfileSpecializations((prev) => {
      const exists = prev.includes(value);
      return exists ? prev.filter((item) => item !== value) : [...prev, value];
    });
  }, []);

  const toggleCrmProfileQuadrant = useCallback((value: string) => {
    setCrmProfileQuadrants((prev) => {
      const exists = prev.includes(value);
      return exists ? prev.filter((item) => item !== value) : [...prev, value];
    });
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void Promise.all([fetchTasks(), fetchOutlookStatus(), fetchTransferInbox()]);
  }, [fetchTasks, fetchOutlookStatus, fetchTransferInbox]);

  const visibleTasks = useMemo(
    () =>
      statusFilter === 'all'
        ? tasks.filter((task) => CRM_OPEN_STATUSES.includes(task.status))
        : tasks,
    [statusFilter, tasks]
  );

  const dashboardFilterMeta = dashboardFilter ? DASHBOARD_FILTER_META[dashboardFilter] : null;

  const clearDashboardFilter = useCallback(() => {
    setDashboardFilter(null);
    onClearInitialDashboardFilter?.();
  }, [onClearInitialDashboardFilter]);

  const selectStatusFilter = useCallback(
    (nextStatus: 'all' | CrmTaskStatus) => {
      setStatusFilter(nextStatus);
      if ((nextStatus === 'lost' || nextStatus === 'won') && dashboardFilter) {
        setDashboardFilter(null);
        onClearInitialDashboardFilter?.();
      }
    },
    [dashboardFilter, onClearInitialDashboardFilter]
  );

  const filteredCountLabel = useMemo(() => {
    if (visibleTasks.length === 1) return '1 task';
    return `${visibleTasks.length} tasks`;
  }, [visibleTasks.length]);

  const calendarSyncFilteredTasks = useMemo(() => {
    const query = calendarSyncSearchText.trim().toLowerCase();
    return tasks.filter((task) => {
      if (calendarSyncStatusFilter !== 'all' && task.status !== calendarSyncStatusFilter) {
        return false;
      }

      if (!query) return true;

      const haystack = [
        task.clientName,
        task.companyName,
        task.email,
        task.phoneFormatted,
        task.phoneRaw,
        ...(task.contactPhones || []),
        ...(task.contactMobilePhones || []),
        ...(task.companyPhones || []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [calendarSyncSearchText, calendarSyncStatusFilter, tasks]);

  const calendarSyncSelectedCount = useMemo(
    () => calendarSyncSelectedTaskIds.length,
    [calendarSyncSelectedTaskIds.length]
  );

  const pendingTransferCount = useMemo(
    () => transferInbox.filter((item) => item.status === 'pending').length,
    [transferInbox]
  );

  const modalUpdates = useMemo(() => {
    if (!selectedTask?.updates?.length) return [];
    return [...selectedTask.updates].sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });
  }, [selectedTask?.updates]);

  const selectedTaskCallOptions = useMemo(() => {
    if (!selectedTask) return [];
    return buildCallOptions(selectedTask);
  }, [selectedTask]);

  const selectedTaskImportEntries = useMemo(() => {
    if (!selectedTask?.importData || typeof selectedTask.importData !== 'object')
      return [] as [string, unknown][];
    return Object.entries(selectedTask.importData);
  }, [selectedTask?.importData]);

  useEffect(() => {
    return () => {
      if (playbackSoundRef.current) {
        playbackSoundRef.current.unloadAsync().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    setCalendarSyncSelectedTaskIds((prev) =>
      prev.filter((taskId) => tasks.some((task) => task._id === taskId))
    );
  }, [tasks]);

  const openDialer = async (task: CrmTaskItem) => {
    const options = buildCallOptions(task);
    if (options.length === 0) {
      Alert.alert('No phone available', 'This contact does not have a valid phone number.');
      return;
    }

    setCallTargetTask(task);
    setCallOptions(options);
    setCallModalVisible(true);
  };

  const connectOutlookCalendar = async () => {
    if (outlookBusy) return;
    try {
      setOutlookBusy(true);
      const authUrl = await crmTaskApi.getOutlookCalendarAuthUrl();
      if (!authUrl) {
        Alert.alert('Connection Error', 'Unable to start Outlook connection.');
        return;
      }
      await Linking.openURL(authUrl);
      Alert.alert(
        'Continue in Browser',
        'Complete Microsoft sign-in, then return here and tap Refresh to update connection status.'
      );
    } catch (e: any) {
      Alert.alert(
        'Connection Error',
        e?.response?.data?.message || e?.message || 'Failed to open Outlook connection flow.'
      );
    } finally {
      setOutlookBusy(false);
    }
  };

  const disconnectOutlookCalendar = () => {
    if (outlookBusy) return;
    Alert.alert('Disconnect Outlook', 'Disconnect your Outlook calendar from this CRM account?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              setOutlookBusy(true);
              await crmTaskApi.disconnectOutlookCalendar();
              await fetchOutlookStatus();
            } catch (e: any) {
              Alert.alert(
                'Disconnect Failed',
                e?.response?.data?.message || e?.message || 'Failed to disconnect Outlook calendar.'
              );
            } finally {
              setOutlookBusy(false);
            }
          })();
        },
      },
    ]);
  };

  const addTaskToOutlookCalendar = async (task: CrmTaskItem) => {
    if (!outlookStatus.connected) {
      Alert.alert('Calendar Not Connected', 'Please connect a calendar first.');
      return;
    }

    try {
      setOutlookSyncingTaskId(task._id);
      const result = await crmTaskApi.addTaskToOutlookCalendar(task._id);

      if (result.pending) {
        Alert.alert('Outlook sync queued', result.message || 'Your calendar update is queued. It has not been confirmed by Outlook yet.');
        return;
      }
      if (!result.eventId) {
        Alert.alert('Outlook confirmation unavailable', 'Outlook has not confirmed an event. Check your calendar and refresh before trying again.');
        return;
      }
      if (result.webLink) {
        Alert.alert('Added to Outlook', 'Task added to your Outlook calendar.', [
          {
            text: 'Open Event',
            onPress: () => {
              if (result.webLink) {
                void Linking.openURL(result.webLink);
              }
            },
          },
          { text: 'OK' },
        ]);
      } else {
        Alert.alert('Added to Outlook', 'Task added to your Outlook calendar.');
      }
    } catch (e: any) {
      Alert.alert(
        'Calendar Sync Failed',
        e?.response?.data?.message || e?.message || 'Failed to add task to Outlook calendar.'
      );
    } finally {
      setOutlookSyncingTaskId(null);
    }
  };

  const addVisibleTasksToOutlookCalendar = async () => {
    if (!outlookStatus.connected) {
      Alert.alert('Outlook Not Connected', 'Connect your Outlook calendar first.');
      return;
    }
    if (tasks.length === 0) {
      Alert.alert('No Tasks', 'There are no tasks to sync.');
      return;
    }

    setCalendarSyncSearchText('');
    setCalendarSyncStatusFilter('all');
    setCalendarSyncSelectedTaskIds(tasks.map((task) => task._id).filter(Boolean));
    setCalendarSyncModalVisible(true);
  };

  const closeCalendarSyncModal = useCallback(() => {
    if (outlookBulkSyncing) return;
    setCalendarSyncModalVisible(false);
  }, [outlookBulkSyncing]);

  const toggleCalendarSyncTask = useCallback((taskId: string) => {
    setCalendarSyncSelectedTaskIds((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    );
  }, []);

  const markFilteredCalendarSyncTasks = useCallback(() => {
    setCalendarSyncSelectedTaskIds((prev) => {
      const merged = new Set(prev);
      for (const task of calendarSyncFilteredTasks) {
        if (task._id) merged.add(task._id);
      }
      return Array.from(merged);
    });
  }, [calendarSyncFilteredTasks]);

  const clearFilteredCalendarSyncTasks = useCallback(() => {
    const filteredIds = new Set(calendarSyncFilteredTasks.map((task) => task._id).filter(Boolean));
    setCalendarSyncSelectedTaskIds((prev) => prev.filter((taskId) => !filteredIds.has(taskId)));
  }, [calendarSyncFilteredTasks]);

  const syncSelectedTasksToOutlookCalendar = useCallback(async () => {
    if (!outlookStatus.connected) {
      Alert.alert('Outlook Not Connected', 'Connect your Outlook calendar first.');
      return;
    }

    if (calendarSyncSelectedTaskIds.length === 0) {
      Alert.alert('No Tasks Selected', 'Select at least one task to sync to calendar.');
      return;
    }

    try {
      setOutlookBulkSyncing(true);
      const result = await crmTaskApi.addTasksToOutlookCalendarBulk(calendarSyncSelectedTaskIds);
      const failedHint =
        result.failedCount > 0
          ? `\n\n${result.failedCount} failed. ${result.failed[0]?.reason || 'Check your task dates and try again.'}`
          : '';
      const pendingHint = result.pendingCount > 0
        ? `\n\n${result.pendingCount} queued, not yet confirmed by Outlook.` : '';
      setCalendarSyncModalVisible(false);
      Alert.alert(
        result.pendingCount > 0 ? 'Outlook sync queued' : 'Outlook Sync Complete',
        `${result.createdCount} task(s) added to calendar.${pendingHint}${failedHint}`
      );
    } catch (e: any) {
      Alert.alert(
        'Bulk Sync Failed',
        e?.response?.data?.message || e?.message || 'Failed to sync tasks to Outlook calendar.'
      );
    } finally {
      setOutlookBulkSyncing(false);
    }
  }, [calendarSyncSelectedTaskIds, outlookStatus.connected]);

  const openTransferModal = async (task: CrmTaskItem) => {
    setTransferTask(task);
    setTransferAgentId('');
    setTransferNote('');
    setTransferModalVisible(true);
    if (transferAgents.length === 0) {
      await fetchTransferAgents(true);
    }
  };

  const closeTransferModal = (force = false) => {
    if (transferSubmitting && !force) return;
    setTransferModalVisible(false);
    setTransferTask(null);
    setTransferAgentId('');
    setTransferNote('');
  };

  const submitTransferRequest = async () => {
    if (!transferTask?._id) return;
    if (!transferAgentId) {
      Alert.alert('Select Agent', 'Please choose a CRM agent to transfer this task.');
      return;
    }

    try {
      setTransferSubmitting(true);
      await crmTaskApi.requestTaskTransfer(transferTask._id, {
        toUserId: transferAgentId,
        note: transferNote.trim() || undefined,
      });
      Alert.alert('Request Sent', 'Transfer request sent to the selected CRM agent.');
      closeTransferModal(true);
      await fetchTransferInbox();
    } catch (e: any) {
      Alert.alert(
        'Transfer Failed',
        e?.response?.data?.message || e?.message || 'Failed to request task transfer.'
      );
    } finally {
      setTransferSubmitting(false);
    }
  };

  const openTransferInboxModal = () => {
    setTransferInboxVisible(true);
    void fetchTransferInbox(true);
  };

  const closeTransferInboxModal = () => {
    if (transferRespondingId) return;
    setTransferInboxVisible(false);
  };

  const respondTransferRequest = async (item: CrmTaskTransferItem, action: 'accept' | 'reject') => {
    const requestId = String(item?._id || '').trim();
    if (!requestId) return;

    try {
      setTransferRespondingId(requestId);
      await crmTaskApi.respondToTransferRequest(requestId, action);
      await Promise.all([fetchTransferInbox(), fetchTasks()]);
      Alert.alert(
        action === 'accept' ? 'Transfer Accepted' : 'Transfer Rejected',
        action === 'accept'
          ? 'This task is now assigned to you.'
          : 'Transfer request was rejected.'
      );
    } catch (e: any) {
      Alert.alert(
        'Response Failed',
        e?.response?.data?.message || e?.message || 'Failed to update transfer request.'
      );
    } finally {
      setTransferRespondingId(null);
    }
  };

  const closeCallModal = useCallback(() => {
    if (dialingNumber) return;
    setCallModalVisible(false);
    setCallTargetTask(null);
    setCallOptions([]);
  }, [dialingNumber]);

  const dialSelectedNumber = useCallback(async (value: string) => {
    const parsed = parseDialablePhone(value);
    if (!parsed) {
      Alert.alert('Unable to call', 'The selected number is invalid.');
      return;
    }

    const url = `tel:${parsed.dial}`;
    setDialingNumber(parsed.display);
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        Alert.alert('Unable to call', 'This device cannot open the dialer.');
        return;
      }

      setCallModalVisible(false);
      await Linking.openURL(url);
    } finally {
      setDialingNumber(null);
    }
  }, []);

  const saveCrmProfile = useCallback(async () => {
    const address = crmProfileAddress.trim();
    const quadrants = crmProfileQuadrants.map((value) => value.trim().toUpperCase()).filter(Boolean);

    if (!address) {
      Alert.alert('Address required', 'Please enter your CRM coverage address.');
      return;
    }

    if (quadrants.length === 0) {
      Alert.alert('Quadrant required', 'Please select at least one CRM quadrant.');
      return;
    }

    if (crmProfileSpecializations.length === 0) {
      Alert.alert('Specialization required', 'Please choose at least one CRM specialization.');
      return;
    }

    try {
      setCrmProfileSaving(true);
      await api.put('/user', {
        crmAddress: address,
        crmQuadrant: quadrants,
        crmSpecializations: crmProfileSpecializations,
      });
      await refreshUser();
      setCrmProfileCaptured(true);
      setCrmProfileModalVisible(false);
      Alert.alert('Saved', 'CRM location profile saved successfully.');
    } catch (e: any) {
      Alert.alert(
        'Error',
        e?.response?.data?.message || e?.message || 'Failed to save CRM profile'
      );
    } finally {
      setCrmProfileSaving(false);
    }
  }, [crmProfileAddress, crmProfileQuadrants, crmProfileSpecializations, refreshUser]);

  const openUrlSafely = async (url: string, errorMessage: string) => {
    const canOpen = await Linking.canOpenURL(url);
    if (!canOpen) {
      Alert.alert('Unable to open', errorMessage);
      return;
    }
    await Linking.openURL(url);
  };

  const openEmailComposer = async (email: string) => {
    const clean = email.trim();
    if (!clean) return;
    await openUrlSafely(`mailto:${clean}`, 'No email app available on this device.');
  };

  const openWebsite = async (website: string) => {
    const url = ensureAbsoluteUrl(website);
    if (!url) {
      Alert.alert('Invalid Link', 'This website link is invalid.');
      return;
    }
    await openUrlSafely(url, 'Unable to open the website link.');
  };

  const openLocation = async (locationText: string) => {
    const query = locationText.trim();
    if (!query) return;
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    await openUrlSafely(url, 'Unable to open map location.');
  };

  const stopRecordingPlayback = useCallback(async () => {
    if (playbackSoundRef.current) {
      try {
        await playbackSoundRef.current.unloadAsync();
      } catch {
        // ignore playback unload errors
      }
      playbackSoundRef.current = null;
    }
    setPlayingRecordingUrl(null);
    setRecordingPlaybackLoadingUrl(null);
  }, []);

  const toggleRecordingPlayback = useCallback(
    async (url?: string) => {
      const targetUrl = String(url || '').trim();
      if (!targetUrl) return;

      if (playingRecordingUrl === targetUrl) {
        await stopRecordingPlayback();
        return;
      }

      setRecordingPlaybackLoadingUrl(targetUrl);
      try {
        if (playbackSoundRef.current) {
          try {
            await playbackSoundRef.current.unloadAsync();
          } catch {
            // ignore previous playback unload errors
          }
          playbackSoundRef.current = null;
        }

        const { sound } = await Audio.Sound.createAsync({ uri: targetUrl }, { shouldPlay: true });

        playbackSoundRef.current = sound;
        setPlayingRecordingUrl(targetUrl);

        sound.setOnPlaybackStatusUpdate((status) => {
          if (!status.isLoaded) return;
          if (status.didJustFinish) {
            void stopRecordingPlayback();
          }
        });
      } catch {
        Alert.alert('Playback Error', 'Unable to play this recording.');
        setPlayingRecordingUrl(null);
      } finally {
        setRecordingPlaybackLoadingUrl((current) => (current === targetUrl ? null : current));
      }
    },
    [playingRecordingUrl, stopRecordingPlayback]
  );

  const openUpdateModal = useCallback((task: CrmTaskItem) => {
    void stopRecordingPlayback();
    setSelectedTask(task);
    setUpdateStatus(task.status || 'new_lead');
    setUpdateLostReason(task.lostReason || '');
    // The lead's upcoming follow-up, or empty when none (or already passed).
    setFollowUpDraft(initialFollowUpDraft(task));
    setComment('');
    setAttachments([]);
    setRecording(null);
    setCommentRecording(null);
    setCommentRecordingDurationMs(0);
    setTranscribingComment(false);
    setEditingUpdateId(null);
    setEditingComment('');
    setEditingStatus(task.status || 'new_lead');
    setEditingLostReason(task.lostReason || '');
    setSectionContactOpen(false);
    setSectionLocationOpen(false);
    setSectionCompanyOpen(false);
    setSectionImportOpen(false);
    setSectionTimelineOpen(false);
    setUpdateModalVisible(true);
  }, [stopRecordingPlayback]);

  useEffect(() => {
    if (!initialTaskId || loading) return;
    const target = tasks.find((t) => t._id === initialTaskId);
    if (target) {
      openUpdateModal(target);
    } else {
      // Not in the loaded page (more than 100 open tasks, or a far-off
      // follow-up opened from the CRM Calendar or a reminder): fetch that one
      // lead and open it (2026-10-11).
      const taskId = initialTaskId;
      void crmTaskApi.getTask(taskId)
        .then((task) => { if (task?._id === taskId) openUpdateModal(task); })
        .catch(() => Alert.alert('Lead not found', 'This lead is no longer assigned to you, or it could not be loaded.'));
    }
    onClearInitialTask?.();
  }, [initialTaskId, loading, tasks, openUpdateModal, onClearInitialTask]);

  const stopCommentRecording = useCallback(
    async (transcribe: boolean) => {
      if (!commentRecording) return;

      setVoiceBusy(true);
      const activeRecording = commentRecording;
      setCommentRecording(null);
      setCommentRecordingDurationMs(0);

      try {
        activeRecording.setOnRecordingStatusUpdate(null);
        await activeRecording.stopAndUnloadAsync();
      } catch {
        // best-effort stop
      }

      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
        });
      } catch {
        // best-effort audio mode reset
      }

      if (!transcribe) {
        setVoiceBusy(false);
        return;
      }

      const uri = activeRecording.getURI();
      if (!uri) {
        setVoiceBusy(false);
        Alert.alert('Recording Error', 'Unable to read recorded audio.');
        return;
      }

      const rawName = uri.split('/').pop() || `crm-comment-${Date.now()}.m4a`;
      const fileName = rawName.includes('.') ? rawName : `${rawName}.m4a`;

      setTranscribingComment(true);
      try {
        const text = await crmTaskApi.transcribeCommentAudio({
          audio: {
            uri,
            name: fileName,
            type: guessAudioMimeType(fileName),
          },
        });

        if (!text) {
          Alert.alert('No speech detected', 'Please try again and speak clearly.');
          return;
        }

        setComment((prev) => {
          const trimmed = prev.trim();
          return trimmed ? `${trimmed} ${text}` : text;
        });
      } catch (e: any) {
        Alert.alert(
          'Transcription Failed',
          e?.response?.data?.message || e?.message || 'Could not transcribe audio.'
        );
      } finally {
        setTranscribingComment(false);
        setVoiceBusy(false);
      }
    },
    [commentRecording]
  );

  const startCommentRecording = async () => {
    if (voiceBusy || transcribingComment || submitting || commentRecording) return;

    try {
      setVoiceBusy(true);
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Microphone Permission',
          'Please allow microphone access to use speech-to-text.'
        );
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      rec.setProgressUpdateInterval(250);
      rec.setOnRecordingStatusUpdate((status: Audio.RecordingStatus) => {
        if (typeof status.durationMillis !== 'number') return;
        setCommentRecordingDurationMs(status.durationMillis);
      });
      await rec.startAsync();

      setCommentRecordingDurationMs(0);
      setCommentRecording(rec);
    } catch {
      Alert.alert('Recording Error', 'Unable to start voice recording.');
    } finally {
      setVoiceBusy(false);
    }
  };

  const toggleCommentRecording = async () => {
    if (commentRecording) {
      await stopCommentRecording(true);
      return;
    }
    await startCommentRecording();
  };

  const closeUpdateModal = (force = false) => {
    if (submitting && !force) return;
    if (commentRecording) {
      void stopCommentRecording(false);
    }
    void stopRecordingPlayback();
    setUpdateModalVisible(false);
    setSelectedTask(null);
    setComment('');
    setUpdateLostReason('');
    setFollowUpDraft({ date: null, time: null });
    setAttachments([]);
    setRecording(null);
    setCommentRecording(null);
    setCommentRecordingDurationMs(0);
    setTranscribingComment(false);
    setTimelineBusyKey(null);
    setEditingUpdateId(null);
    setEditingComment('');
    setEditingLostReason('');
  };

  const htmlToPlainText = (html: string): string => {
    let text = html;
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/li>/gi, '\n');
    text = text.replace(/<li[^>]*>/gi, '  • ');
    text = text.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
    text = text.replace(/<\/?(h[1-6])[^>]*>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
  };

  const plainTextToHtml = (text: string): string => {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const paragraphs = escaped.split(/\n\n+/);
    return paragraphs.map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
  };

  const toggleEmailEditPreview = () => {
    if (emailPreviewMode) {
      const plain = htmlToPlainText(emailHtmlBody || emailBody);
      setEmailBody(plain);
      setEmailPreviewMode(false);
    } else {
      const html = plainTextToHtml(emailBody);
      setEmailHtmlBody(html);
      setEmailPreviewMode(true);
    }
  };

  const openEmailModal = (task: CrmTaskItem) => {
    setEmailTask(task);
    setEmailTo(task.email || '');
    setEmailSubject('');
    setEmailBody('');
    setEmailHtmlBody('');
    setEmailRecording(null);
    setEmailRecordingDurationMs(0);
    setEmailTranscribing(false);
    setEmailRewriting(false);
    setEmailIsHtml(false);
    setEmailPreviewMode(false);
    setEmailModalVisible(true);
  };

  const closeEmailModal = () => {
    if (emailRecording) {
      emailRecording.stopAndUnloadAsync().catch(() => undefined);
    }
    setEmailModalVisible(false);
    setEmailTask(null);
    setEmailTo('');
    setEmailSubject('');
    setEmailBody('');
    setEmailHtmlBody('');
    setEmailRecording(null);
    setEmailRecordingDurationMs(0);
    setEmailTranscribing(false);
    setEmailRewriting(false);
    setEmailIsHtml(false);
    setEmailPreviewMode(false);
  };

  const startEmailVoiceRecording = async () => {
    if (emailVoiceBusy || emailTranscribing || emailRecording) return;
    try {
      setEmailVoiceBusy(true);
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Microphone Permission',
          'Please allow microphone access to use voice-to-text.'
        );
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      rec.setProgressUpdateInterval(250);
      rec.setOnRecordingStatusUpdate((status: Audio.RecordingStatus) => {
        if (typeof status.durationMillis === 'number')
          setEmailRecordingDurationMs(status.durationMillis);
      });
      await rec.startAsync();
      setEmailRecordingDurationMs(0);
      setEmailRecording(rec);
    } catch {
      Alert.alert('Recording Error', 'Unable to start voice recording.');
    } finally {
      setEmailVoiceBusy(false);
    }
  };

  const stopEmailVoiceRecording = async () => {
    if (!emailRecording) return;
    setEmailVoiceBusy(true);
    const activeRec = emailRecording;
    setEmailRecording(null);
    setEmailRecordingDurationMs(0);

    try {
      activeRec.setOnRecordingStatusUpdate(null);
      await activeRec.stopAndUnloadAsync();
    } catch {
      /* best-effort */
    }

    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
    } catch {
      /* best-effort */
    }

    const uri = activeRec.getURI();
    if (!uri) {
      setEmailVoiceBusy(false);
      Alert.alert('Recording Error', 'Unable to read recorded audio.');
      return;
    }

    const rawName = uri.split('/').pop() || `email-voice-${Date.now()}.m4a`;
    const fileName = rawName.includes('.') ? rawName : `${rawName}.m4a`;

    setEmailTranscribing(true);
    try {
      const text = await crmTaskApi.transcribeCommentAudio({
        audio: { uri, name: fileName, type: guessAudioMimeType(fileName) },
      });
      if (!text) {
        Alert.alert('No speech detected', 'Please try again and speak clearly.');
        return;
      }
      setEmailBody((prev) => {
        const trimmed = prev.trim();
        return trimmed ? `${trimmed}\n${text}` : text;
      });
    } catch (e: any) {
      Alert.alert(
        'Transcription Failed',
        e?.response?.data?.message || e?.message || 'Could not transcribe audio.'
      );
    } finally {
      setEmailTranscribing(false);
      setEmailVoiceBusy(false);
    }
  };

  const toggleEmailVoiceRecording = async () => {
    if (emailRecording) {
      await stopEmailVoiceRecording();
      return;
    }
    await startEmailVoiceRecording();
  };

  const rewriteEmailAI = async () => {
    const body = emailBody.trim();
    if (!body) {
      Alert.alert('Empty body', 'Write or dictate something before using Software rewrite.');
      return;
    }
    setEmailRewriting(true);
    try {
      const result = await crmTaskApi.rewriteEmailWithAI({
        body,
        subject: emailSubject.trim() || undefined,
        clientName: emailTask?.clientName || undefined,
        senderName: user?.username || user?.email?.split('@')[0] || undefined,
        senderCompany: user?.companyName || undefined,
      });
      setEmailSubject(result.subject);
      setEmailHtmlBody(result.body);
      setEmailBody(result.body);
      setEmailIsHtml(true);
      setEmailPreviewMode(true);
    } catch (e: any) {
      Alert.alert(
        'Software Rewrite Failed',
        e?.response?.data?.message || e?.message || 'Could not rewrite email.'
      );
    } finally {
      setEmailRewriting(false);
    }
  };

  const sendEmail = async () => {
    const to = emailTo.trim();
    if (!to) {
      Alert.alert('No recipient', 'This lead has no email address.');
      return;
    }
    const subject = emailSubject.trim();
    const body = emailBody.trim();

    const senderName = user?.username || user?.email?.split('@')[0] || '';
    const senderCompany = user?.companyName || '';
    const senderPhone = user?.contactPhone || '';
    const senderEmail = user?.contactEmail || user?.email || '';

    const sigParts: string[] = [];
    if (senderName) sigParts.push(`<strong>${senderName}</strong>`);
    if (senderCompany) sigParts.push(senderCompany);
    if (senderPhone) sigParts.push(senderPhone);
    if (senderEmail) sigParts.push(`<a href="mailto:${senderEmail}">${senderEmail}</a>`);
    const htmlSignature =
      sigParts.length > 0
        ? `<br><br><p style="color:#64748B;font-size:13px;">—<br>${sigParts.join('<br>')}</p>`
        : '';

    const useHtml = emailIsHtml && emailPreviewMode && emailHtmlBody;
    const htmlBody = useHtml
      ? `${emailHtmlBody}${htmlSignature}`
      : `${plainTextToHtml(body)}${htmlSignature}`;

    const plainBody = htmlBody
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .trim();

    setEmailPreparedTo(to);
    setEmailPreparedSubject(subject);
    setEmailPreparedBody(plainBody);
    setEmailPreparedHtmlBody(htmlBody);
    setEmailModalVisible(false);
    setTimeout(() => {
      setEmailClientChooserVisible(true);
    }, 350);
  };

  const closeEmailClientChooser = () => {
    setEmailClientChooserVisible(false);
  };

  const tryOpenEmailClientUrls = async (urls: string[]) => {
    for (const url of urls) {
      try {
        await Linking.openURL(url);
        return true;
      } catch {
        // try next candidate scheme
      }
    }
    return false;
  };

  const openWithGmail = async () => {
    closeEmailClientChooser();
    const to = encodeURIComponent(emailPreparedTo);
    const subject = encodeURIComponent(emailPreparedSubject);
    const body = encodeURIComponent(emailPreparedBody);

    const opened = await tryOpenEmailClientUrls([
      `googlegmail://co?to=${to}&subject=${subject}&body=${body}`,
      `gmail://co?to=${to}&subject=${subject}&body=${body}`,
    ]);

    if (!opened) {
      Alert.alert('Gmail Not Available', 'Gmail app is not installed on this device.');
      return;
    }
  };

  const openWithOutlook = async () => {
    closeEmailClientChooser();
    const to = encodeURIComponent(emailPreparedTo);
    const subject = encodeURIComponent(emailPreparedSubject);
    const body = encodeURIComponent(emailPreparedBody);

    const opened = await tryOpenEmailClientUrls([
      `ms-outlook://compose?to=${to}&subject=${subject}&body=${body}`,
      `outlook://compose?to=${to}&subject=${subject}&body=${body}`,
    ]);

    if (!opened) {
      Alert.alert('Outlook Not Available', 'Outlook app is not installed on this device.');
      return;
    }
  };

  const openWithDefaultMail = async () => {
    closeEmailClientChooser();
    try {
      const isAvailable = await MailComposer.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert('No Email App', 'No email application available on this device.');
        return;
      }
      await MailComposer.composeAsync({
        recipients: [emailPreparedTo],
        subject: emailPreparedSubject || undefined,
        body: emailPreparedHtmlBody,
        isHtml: true,
      });
    } catch {
      Alert.alert('Error', 'Failed to open email composer.');
    }
  };

  const pickAttachments = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.length) return;

      const files = result.assets.map(
        (asset: DocumentPicker.DocumentPickerAsset, index: number) => ({
          uri: asset.uri,
          name: asset.name || `attachment_${Date.now()}_${index}`,
          type: asset.mimeType || 'application/octet-stream',
        })
      );

      setAttachments((prev) => [...prev, ...files].slice(0, 10));
    } catch {
      Alert.alert('Error', 'Failed to pick attachment files');
    }
  };

  const pickGalleryImages = async () => {
    try {
      if (attachments.length >= 10) {
        Alert.alert('Attachment Limit', 'You can upload up to 10 attachments per update.');
        return;
      }

      if (!(await ensurePhotoPickerAccess())) {
        Alert.alert('Permission Required', 'Please allow gallery access to attach images.');
        return;
      }

      const remaining = Math.max(10 - attachments.length, 1);
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        selectionLimit: remaining,
        quality: 0.85,
      });

      if (result.canceled || !result.assets?.length) return;

      const files = result.assets.map((asset: ImagePicker.ImagePickerAsset, index: number) => {
        const fallbackName = `crm-image-${Date.now()}-${index + 1}.jpg`;
        const name = asset.fileName || fallbackName;
        const ext = name.split('.').pop()?.toLowerCase();
        const mimeFromExt =
          ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

        return {
          uri: asset.uri,
          name,
          type: asset.mimeType || mimeFromExt,
        };
      });

      setAttachments((prev) => [...prev, ...files].slice(0, 10));
    } catch {
      Alert.alert('Error', 'Failed to pick gallery images.');
    }
  };

  const pickRecording = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        multiple: false,
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      setRecording({
        uri: asset.uri,
        name: asset.name || `recording_${Date.now()}.m4a`,
        type: asset.mimeType || guessAudioMimeType(asset.name || 'recording.m4a'),
      });
    } catch {
      Alert.alert('Error', 'Failed to pick recording file');
    }
  };

  const submitUpdate = async () => {
    if (!selectedTask) return;
    if (updateStatus === 'lost' && !updateLostReason) {
      Alert.alert('Lost Reason Required', 'Please choose a lost reason before submitting.');
      return;
    }

    try {
      setSubmitting(true);
      const updatedTask = await crmTaskApi.submitTaskUpdate(selectedTask._id, {
        comment,
        status: updateStatus,
        lostReason: updateStatus === 'lost' && updateLostReason ? updateLostReason : undefined,
        attachments,
        recording,
        // Only a changed follow-up is sent; leaving it alone keeps the lead's.
        followUp: followUpChange(selectedTask, followUpDraft, updateStatus, deviceTimeZone()),
      });
      if (updatedTask?._id) {
        applyTaskMutationResult(updatedTask);
      }

      const updatedStatus = updatedTask?.status || updateStatus;
      const nextStatusFilter =
        updatedStatus === 'lost' || updatedStatus === 'won' ? updatedStatus : statusFilter;
      const shouldClearDashboardFilter = nextStatusFilter === 'lost' || nextStatusFilter === 'won';
      if (nextStatusFilter !== statusFilter) {
        setStatusFilter(nextStatusFilter);
      }
      if (shouldClearDashboardFilter) {
        setDashboardFilter(null);
        onClearInitialDashboardFilter?.();
        onClearInitialStatusFilter?.();
      }

      Alert.alert('Success', 'CRM task updated successfully.');
      closeUpdateModal(true);
      setLoading(true);
      await fetchTasks({
        statusFilterOverride: nextStatusFilter,
        dashboardFilterOverride: shouldClearDashboardFilter ? null : dashboardFilter,
      });
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.message || e?.message || 'Failed to update task');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, isCompact && styles.scrollContentCompact]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#0284C7"
            colors={['#0284C7']}
          />
        }>
        <View style={[styles.heroCard, isCompact && styles.heroCardCompact]}>
          <View style={styles.heroGlow} />
          <View style={styles.heroDepth} />
          <View style={[styles.heroTopRow, isCompact && styles.heroTopRowCompact]}>
            <View style={[styles.heroTopLeft, isCompact && styles.heroTopLeftCompact]}>
              <TouchableOpacity
                onPress={onOpenDrawer}
                style={[styles.menuBtn, isCompact && styles.topBtnCompact]}>
                <Feather name="menu" size={22} color="#fff" />
              </TouchableOpacity>
              <View>
                <Text style={[styles.heroTitle, isCompact && styles.heroTitleCompact]}>
                  CRM Tasks
                </Text>
                <Text style={[styles.heroGreeting, isCompact && styles.heroGreetingCompact]}>
                  {greeting}, <Text style={styles.heroName}>{displayName}</Text>
                </Text>
                <Text style={[styles.heroSubtitle, isCompact && styles.heroSubtitleCompact]}>
                  {filteredCountLabel}
                </Text>
              </View>
            </View>
            <View style={styles.heroActions}>
              <TouchableOpacity
                onPress={onBack}
                style={[styles.backBtn, isCompact && styles.topBtnCompact]}>
                <Feather name="arrow-left" size={20} color="rgba(255,255,255,0.95)" />
              </TouchableOpacity>
            </View>
          </View>

          <View style={[styles.searchRow, isCompact && styles.searchRowCompact]}>
            <Feather name="search" size={16} color="rgba(255,255,255,0.8)" />
            <TextInput
              style={[styles.searchInput, isCompact && styles.searchInputCompact]}
              placeholder="Search name, email, phone"
              placeholderTextColor="rgba(255,255,255,0.65)"
              value={searchText}
              onChangeText={setSearchText}
              autoCapitalize="none"
            />
          </View>

          <View style={[styles.filterGrid, isCompact && styles.filterGridCompact]}>
            {STATUS_OPTIONS.map((option) => {
              const meta = STATUS_FILTER_COLORS[option.key];
              const isActive = statusFilter === option.key;
              const label = isCompact ? option.compactLabel || option.label : option.label;

              return (
                <TouchableOpacity
                  key={option.key}
                  style={[
                    styles.filterChip,
                    isCompact && styles.filterChipCompact,
                    isVeryCompact && styles.filterChipVeryCompact,
                    {
                      backgroundColor: isActive ? meta.activeBg : meta.bg,
                      borderColor: isActive ? meta.activeBg : meta.border,
                      shadowColor: meta.shadow,
                    },
                    isActive && styles.filterChipActive,
                  ]}
                  onPress={() => selectStatusFilter(option.key)}
                  activeOpacity={0.82}>
                  <Text
                    style={[
                      styles.filterChipText,
                      isCompact && styles.filterChipTextCompact,
                      isVeryCompact && styles.filterChipTextVeryCompact,
                      { color: isActive ? meta.activeText : meta.text },
                      isActive && styles.filterChipTextActive,
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.78}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {dashboardFilterMeta ? (
            <View style={styles.dashboardFilterBanner}>
              <View style={styles.dashboardFilterIcon}>
                <Feather name="filter" size={13} color="#0C4A6E" />
              </View>
              <View style={styles.dashboardFilterTextWrap}>
                <Text style={styles.dashboardFilterTitle}>{dashboardFilterMeta.label}</Text>
                <Text style={styles.dashboardFilterDescription}>{dashboardFilterMeta.description}</Text>
              </View>
              <TouchableOpacity
                style={styles.dashboardFilterClear}
                onPress={clearDashboardFilter}
                activeOpacity={0.8}
              >
                <Feather name="x" size={15} color="#0C4A6E" />
              </TouchableOpacity>
            </View>
          ) : null}

          <View style={[styles.heroIntegrationRow, isCompact && styles.heroIntegrationRowCompact, isVeryCompact && styles.heroIntegrationRowVeryCompact]}>
            <View
              style={[
                styles.heroIntegrationCard,
                styles.quickAddHeroCard,
              ]}>
              <View style={styles.heroIntegrationTopBar}>
                <View style={styles.heroIntegrationHeader}>
                  <Feather name="user-plus" size={14} color="#DCFCE7" />
                  <Text style={styles.heroIntegrationTitle}>Quick Add</Text>
                </View>
                <View style={styles.quickAddHeroTag}>
                  <Text style={styles.quickAddHeroTagText}>Organic</Text>
                </View>
              </View>

              <Text style={styles.heroIntegrationText}>
                Add a lead with name, phone, CRM specialization, due date, and notes.
              </Text>
              <TouchableOpacity
                style={[styles.heroIntegrationBulkBtn, styles.quickAddHeroBtn]}
                onPress={() => setQuickAddOpen(true)}
                disabled={quickAdding}>
                <Feather name="plus-circle" size={15} color="#fff" />
                <Text style={styles.heroIntegrationBulkBtnText}>
                  {quickAdding ? 'Creating...' : 'Add Lead'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.heroIntegrationCard}>
              <View style={styles.heroIntegrationHeader}>
                <Feather name="repeat" size={14} color="#5B21B6" />
                <Text style={styles.heroIntegrationTitle}>Transfer Inbox</Text>
              </View>
              <Text style={styles.heroIntegrationText}>
                {pendingTransferCount} pending request{pendingTransferCount === 1 ? '' : 's'}
              </Text>
              <View style={styles.heroIntegrationActions}>
                <TouchableOpacity
                  style={[styles.heroIntegrationBtn, styles.heroIntegrationBtnRefresh]}
                  onPress={() => void fetchTransferInbox(true)}
                  disabled={transferInboxLoading}>
                  <Text style={[styles.heroIntegrationBtnText, styles.heroIntegrationBtnTextDark]}>Refresh</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.heroIntegrationBtn, styles.heroIntegrationBtnTransfer]}
                  onPress={openTransferInboxModal}>
                  <Text style={[styles.heroIntegrationBtnText, styles.heroIntegrationBtnTextLight]}>
                    Open Inbox
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>

        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color="#0284C7" />
          </View>
        ) : error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : visibleTasks.length === 0 ? (
          <View style={styles.emptyCard}>
            <Feather name="phone-off" size={38} color="#9CA3AF" />
            <Text style={styles.emptyTitle}>No tasks found</Text>
            <Text style={styles.emptySubtitle}>Try changing filters or refresh again.</Text>
          </View>
        ) : (
          <View style={styles.taskList}>
            {visibleTasks.map((task) => {
              const badge = getStatusBadge(task.status);
              const socialLinks = parseSocialLinks(task.contactSocials);
              const callOptionCount = buildCallOptions(task).length;
              const locationLabel = task.companyLocation || task.contactLocation || '';
              const locationMeta = [
                task.quadrant ? `Quadrant ${task.quadrant.toUpperCase()}` : '',
                specializationLabel(task.specialization),
                task.industry || '',
              ]
                .filter(Boolean)
                .join(' • ');
              const websiteLabel = task.website || task.companyWebsiteDomain || '';
              return (
                <View
                  key={task._id}
                  style={[
                    styles.taskCard,
                    isCompact && styles.taskCardCompact,
                    isVeryCompact && styles.taskCardVeryCompact,
                  ]}>
                  <View style={[styles.taskHeaderRow, isCompact && styles.taskHeaderRowCompact]}>
                    <View style={styles.taskHeaderInfo}>
                      <Text
                        style={[
                          styles.taskClient,
                          isCompact && styles.taskClientCompact,
                          isVeryCompact && { fontSize: 13 },
                        ]}
                        numberOfLines={1}>
                        {task.clientName || 'Unnamed Client'}
                      </Text>
                      <Text
                        style={[
                          styles.taskMeta,
                          isCompact && styles.taskMetaCompact,
                          isVeryCompact && { fontSize: 10 },
                        ]}
                        numberOfLines={1}>
                        {task.companyName || task.email || 'No company/email'}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.statusBadge,
                        isVeryCompact && styles.statusBadgeVeryCompact,
                        { backgroundColor: badge.bg },
                      ]}>
                      <Text
                        style={[
                          styles.statusBadgeText,
                          isVeryCompact && { fontSize: 9 },
                          { color: badge.text },
                        ]}>
                        {statusText(task.status)}
                      </Text>
                    </View>
                  </View>

                  <View style={[styles.taskInfoRow, isCompact && styles.taskInfoRowCompact]}>
                    <Feather name="phone" size={14} color="#6B7280" />
                    <Text style={[styles.taskInfoText, isCompact && styles.taskInfoTextCompact]}>
                      {buildCallOptions(task)[0]?.value || 'No phone available'}
                      {callOptionCount > 1 ? ` (+${callOptionCount - 1} more)` : ''}
                    </Text>
                  </View>

                  {task.email ? (
                    <TouchableOpacity
                      style={[styles.taskInfoRow, isCompact && styles.taskInfoRowCompact]}
                      onPress={() => void openEmailComposer(task.email || '')}>
                      <Feather name="mail" size={14} color="#6B7280" />
                      <Text
                        style={[
                          styles.taskInfoText,
                          isCompact && styles.taskInfoTextCompact,
                          styles.taskLinkText,
                        ]}>
                        {task.email}
                      </Text>
                      <Feather name="external-link" size={12} color="#0369A1" />
                    </TouchableOpacity>
                  ) : null}

                  {locationLabel ? (
                    <TouchableOpacity
                      style={[styles.taskInfoRow, isCompact && styles.taskInfoRowCompact]}
                      onPress={() => void openLocation(locationLabel)}>
                      <Feather name="map-pin" size={14} color="#6B7280" />
                      <Text
                        style={[
                          styles.taskInfoText,
                          isCompact && styles.taskInfoTextCompact,
                          styles.taskLinkText,
                        ]}>
                        {locationLabel}
                        {locationMeta ? ` • ${locationMeta}` : ''}
                      </Text>
                      <Feather name="external-link" size={12} color="#0369A1" />
                    </TouchableOpacity>
                  ) : null}

                  {websiteLabel ? (
                    <TouchableOpacity
                      style={[styles.taskInfoRow, isCompact && styles.taskInfoRowCompact]}
                      onPress={() => void openWebsite(websiteLabel)}>
                      <Feather name="globe" size={14} color="#6B7280" />
                      <Text
                        style={[
                          styles.taskInfoText,
                          isCompact && styles.taskInfoTextCompact,
                          styles.taskLinkText,
                        ]}>
                        {websiteLabel}
                      </Text>
                      <Feather name="external-link" size={12} color="#0369A1" />
                    </TouchableOpacity>
                  ) : null}

                  {task.listItems?.length ? (
                    <View style={[styles.taskInfoRow, isCompact && styles.taskInfoRowCompact]}>
                      <Feather name="list" size={14} color="#6B7280" />
                      <Text
                        style={[styles.taskInfoText, isCompact && styles.taskInfoTextCompact]}
                        numberOfLines={2}>
                        {listLabel(task.listItems)}
                      </Text>
                    </View>
                  ) : null}

                  {socialLinks.length > 0 ? (
                    <View style={[styles.taskInfoRow, isCompact && styles.taskInfoRowCompact]}>
                      <Feather name="at-sign" size={14} color="#6B7280" />
                      <View style={styles.socialChipWrap}>
                        {socialLinks.map((link, index) => (
                          <TouchableOpacity
                            key={`${link.url}-${index}`}
                            style={[styles.socialChip, isCompact && styles.socialChipCompact]}
                            onPress={() =>
                              void openUrlSafely(link.url, 'Unable to open social link.')
                            }>
                            <FontAwesome
                              name={getSocialIconName(link.platform)}
                              size={12}
                              color="#075985"
                            />
                            <Text style={styles.socialChipText} numberOfLines={1}>
                              {link.label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  ) : null}

                  <View style={[styles.taskInfoRow, isCompact && styles.taskInfoRowCompact]}>
                    <Feather name="calendar" size={14} color="#6B7280" />
                    <Text style={[styles.taskInfoText, isCompact && styles.taskInfoTextCompact]}>
                      Start {formatDate(task.taskStartDate)} • Due {formatDate(task.dueDate)}
                    </Text>
                  </View>

                  {task.followUpDate ? (
                    <View style={[styles.taskInfoRow, isCompact && styles.taskInfoRowCompact]}>
                      <Feather name="flag" size={14} color={isFollowUpPast(task) ? '#B91C1C' : '#0369A1'} />
                      <Text
                        style={[
                          styles.taskInfoText,
                          isCompact && styles.taskInfoTextCompact,
                          { color: isFollowUpPast(task) ? '#B91C1C' : '#0369A1', fontWeight: '700' },
                        ]}>
                        {isFollowUpPast(task) ? 'Follow-up overdue: ' : 'Follow-up '}
                        {formatFollowUp(task.followUpDate, task.followUpTime)}
                      </Text>
                    </View>
                  ) : null}

                  {task.latestComment ? (
                    <Text style={styles.latestComment} numberOfLines={2}>
                      Latest: {task.latestComment}
                    </Text>
                  ) : null}

                  {task.latestRecordingUrl ? (
                    <TouchableOpacity
                      style={styles.latestRecordingBtn}
                      onPress={() => void toggleRecordingPlayback(task.latestRecordingUrl)}>
                      {recordingPlaybackLoadingUrl === task.latestRecordingUrl ? (
                        <ActivityIndicator size="small" color="#075985" />
                      ) : (
                        <Feather
                          name={
                            playingRecordingUrl === task.latestRecordingUrl
                              ? 'square'
                              : 'play-circle'
                          }
                          size={14}
                          color="#075985"
                        />
                      )}
                      <Text style={styles.latestRecordingBtnText}>
                        {recordingPlaybackLoadingUrl === task.latestRecordingUrl
                          ? 'Loading recording...'
                          : playingRecordingUrl === task.latestRecordingUrl
                            ? 'Stop latest recording'
                            : 'Play latest recording'}
                      </Text>
                    </TouchableOpacity>
                  ) : null}

                  <View
                    style={[
                      styles.taskActionRow,
                      isCompact && styles.taskActionRowCompact,
                      isVeryCompact && styles.taskActionRowVeryCompact,
                    ]}>
                    <TouchableOpacity
                      style={[
                        styles.actionBtn,
                        isCompact && styles.actionBtnCompact,
                        isVeryCompact && styles.actionBtnVeryCompact,
                        styles.callBtn,
                      ]}
                      onPress={() => openDialer(task)}
                      accessibilityRole="button"
                      accessibilityLabel={`Call ${task.clientName || 'client'}`}
                      accessibilityState={{ disabled: !hasAnyCallNumber(task) }}
                      disabled={!hasAnyCallNumber(task)}>
                      <Feather name="phone-call" size={isVeryCompact ? 14 : 15} color="#0C4A6E" />
                      {!isVeryCompact && (
                        <Text
                          style={[styles.actionBtnText, isCompact && styles.actionBtnTextCompact, { color: '#0C4A6E' }]}>
                          Call
                        </Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.actionBtn,
                        isCompact && styles.actionBtnCompact,
                        isVeryCompact && styles.actionBtnVeryCompact,
                        styles.emailBtn,
                      ]}
                      onPress={() => openEmailModal(task)} accessibilityRole="button" accessibilityLabel={`Email ${task.clientName || 'client'}`}>
                      <Feather name="mail" size={isVeryCompact ? 14 : 15} color="#fff" />
                      {!isVeryCompact && (
                        <Text
                          style={[styles.actionBtnText, isCompact && styles.actionBtnTextCompact]}>
                          Email
                        </Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.actionBtn,
                        isCompact && styles.actionBtnCompact,
                        isVeryCompact && styles.actionBtnVeryCompact,
                        styles.updateBtn,
                      ]}
                      onPress={() => openUpdateModal(task)} accessibilityRole="button" accessibilityLabel={`Update ${task.clientName || 'task'}`}>
                      <Feather name="edit-3" size={isVeryCompact ? 14 : 15} color="#fff" />
                      {!isVeryCompact && (
                        <Text
                          style={[styles.actionBtnText, isCompact && styles.actionBtnTextCompact]}>
                          Update
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>

                  <View
                    style={[
                      styles.taskActionRowSecondary,
                      isCompact && styles.taskActionRowCompact,
                      isVeryCompact && styles.taskActionRowVeryCompact,
                    ]}>
                    <TouchableOpacity
                      style={[
                        styles.actionBtn,
                        isCompact && styles.actionBtnCompact,
                        isVeryCompact && styles.actionBtnVeryCompact,
                        styles.calendarBtn,
                      ]}
                      onPress={() => void addTaskToOutlookCalendar(task)}
                      accessibilityRole="button"
                      accessibilityLabel={`Add ${task.clientName || 'task'} to calendar`}
                      accessibilityState={{ disabled: outlookBulkSyncing || outlookSyncingTaskId === task._id, busy: outlookSyncingTaskId === task._id }}
                      disabled={
                        outlookBulkSyncing ||
                        outlookSyncingTaskId === task._id
                      }>
                      {outlookSyncingTaskId === task._id ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Feather name="calendar" size={isVeryCompact ? 14 : 15} color="#fff" />
                      )}
                      {!isVeryCompact && (
                        <Text style={[styles.actionBtnText, isCompact && styles.actionBtnTextCompact]}>
                          Calendar
                        </Text>
                      )}
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.actionBtn,
                        isCompact && styles.actionBtnCompact,
                        isVeryCompact && styles.actionBtnVeryCompact,
                        styles.transferBtn,
                      ]}
                      onPress={() => void openTransferModal(task)} accessibilityRole="button" accessibilityLabel={`Transfer ${task.clientName || 'task'}`}>
                      <Feather name="repeat" size={isVeryCompact ? 14 : 15} color="#fff" />
                      {!isVeryCompact && (
                        <Text style={[styles.actionBtnText, isCompact && styles.actionBtnTextCompact]}>
                          Transfer
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      <Modal
        visible={quickAddOpen}
        transparent
        animationType="fade"
        onRequestClose={() => !quickAdding && setQuickAddOpen(false)}>
        <CrmModalFrame label="Quick Add lead form" onClose={() => !quickAdding && setQuickAddOpen(false)}
          cardStyle={[styles.quickAddModal, isVeryCompact && styles.quickAddModalCompact]}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Quick Add</Text>
                <Text style={styles.quickAddModalSubtitle}>Organic lead</Text>
              </View>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close Quick Add" accessibilityState={{ disabled: quickAdding }} disabled={quickAdding} onPress={() => setQuickAddOpen(false)} style={[styles.quickAddCloseBtn, crmTouchTarget]}>
                <Feather name="x" size={18} color="#334155" />
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.quickAddInput}
              value={quickAddName}
              accessibilityLabel="Lead name"
              onChangeText={setQuickAddName}
              placeholder="Name"
              placeholderTextColor="#94A3B8"
              editable={!quickAdding}
            />
            <TextInput
              style={styles.quickAddInput}
              value={quickAddPhone}
              accessibilityLabel="Lead phone number"
              onChangeText={setQuickAddPhone}
              placeholder="Phone number"
              placeholderTextColor="#94A3B8"
              keyboardType="phone-pad"
              editable={!quickAdding}
            />
            <Text style={styles.quickAddFieldLabel}>CRM specialization</Text>
            <View style={styles.quickAddChipGrid}>
              {CRM_SPECIALIZATION_OPTIONS.map((option) => {
                const selected = quickAddSpecialization === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    disabled={quickAdding}
                    onPress={() => setQuickAddSpecialization(option.value)}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected, disabled: quickAdding }}
                    style={[styles.quickAddSpecializationChip, selected && styles.quickAddSpecializationChipActive]}
                    activeOpacity={0.8}>
                    <Text
                      style={[
                        styles.quickAddSpecializationChipText,
                        selected && styles.quickAddSpecializationChipTextActive,
                      ]}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.quickAddFieldLabel}>Due date</Text>
            <TouchableOpacity
              disabled={quickAdding}
              style={styles.quickAddDateButton}
              accessibilityRole="button"
              accessibilityLabel={`Due date: ${formatQuickAddDueDate(quickAddDueDate)}`}
              accessibilityState={{ disabled: quickAdding, expanded: showQuickAddDuePicker }}
              onPress={() => setShowQuickAddDuePicker(true)}
              activeOpacity={0.8}>
              <Feather name="calendar" size={16} color="#0284C7" />
              <Text style={styles.quickAddDateButtonText}>{formatQuickAddDueDate(quickAddDueDate)}</Text>
            </TouchableOpacity>
            {showQuickAddDuePicker ? (
              <DateTimePicker
                value={quickAddDueDate}
                mode="date"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                onChange={handleQuickAddDueDateChange}
              />
            ) : null}
            <TextInput
              style={[styles.quickAddInput, styles.quickAddNotesInput]}
              value={quickAddNotes}
              accessibilityLabel="Lead notes"
              onChangeText={setQuickAddNotes}
              placeholder="Notes"
              placeholderTextColor="#94A3B8"
              multiline
              textAlignVertical="top"
              editable={!quickAdding}
            />
            <View style={styles.modalFooterRow}>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Cancel Quick Add" accessibilityState={{ disabled: quickAdding }} disabled={quickAdding} onPress={() => setQuickAddOpen(false)} style={[styles.cancelBtn, crmTouchTarget]}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Create lead" accessibilityState={{ disabled: quickAdding, busy: quickAdding }} disabled={quickAdding} onPress={submitQuickAdd} style={[styles.submitBtn, styles.quickAddCreateBtn, crmTouchTarget, quickAdding && styles.quickAddDisabledBtn]}>
                <Text style={styles.submitBtnText}>{quickAdding ? 'Creating...' : 'Create'}</Text>
              </TouchableOpacity>
            </View>
        </CrmModalFrame>
      </Modal>

      <Modal
        visible={updateModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => closeUpdateModal()}>
        <CrmModalFrame label="Task update form" onClose={() => closeUpdateModal()}
          cardStyle={[styles.modalCard, isCompact && styles.modalCardCompact]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Task Update</Text>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close task update" accessibilityState={{ disabled: submitting }} style={crmTouchTarget} onPress={() => closeUpdateModal()} disabled={submitting}>
                  <Feather name="x" size={20} color="#6B7280" />
                </TouchableOpacity>
              </View>

              <View style={[styles.modalBodyScroll, styles.modalBodyContent]}>
                <Text style={styles.modalClientName}>{selectedTask?.clientName || 'Client'}</Text>
                {selectedTask?.companyName ? (
                  <Text style={styles.modalMetaText}>Company: {selectedTask.companyName}</Text>
                ) : null}
                {selectedTask?.industry ? (
                  <Text style={styles.modalMetaText}>
                    {selectedTask.industry}
                    {selectedTask?.quadrant
                      ? ` • Quadrant ${selectedTask.quadrant.toUpperCase()}`
                      : ''}
                    {selectedTask?.specialization
                      ? ` • ${specializationLabel(selectedTask.specialization)}`
                      : ''}
                  </Text>
                ) : selectedTask?.specialization ? (
                  <Text style={styles.modalMetaText}>
                    Specialization: {specializationLabel(selectedTask.specialization)}
                  </Text>
                ) : null}
                {selectedTask?.notes ? (
                  <Text style={[styles.modalMetaText, { fontStyle: 'italic' }]} numberOfLines={2}>
                    Notes: {selectedTask.notes}
                  </Text>
                ) : null}

                {/* ── Contact & Phones (collapsed) ── */}
                <TouchableOpacity
                  style={accStyles.header}
                  onPress={() => setSectionContactOpen((p) => !p)}
                  activeOpacity={0.7}>
                  <View style={accStyles.headerLeft}>
                    <View style={[accStyles.icon, { backgroundColor: '#DBEAFE' }]}>
                      <Feather name="phone" size={13} color="#1D4ED8" />
                    </View>
                    <Text style={accStyles.headerText}>Contact & Phones</Text>
                  </View>
                  <Feather
                    name={sectionContactOpen ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color="#6B7280"
                  />
                </TouchableOpacity>
                {sectionContactOpen ? (
                  <View style={accStyles.body}>
                    {selectedTaskCallOptions.length > 0 ? (
                      <Text style={styles.modalMetaText}>
                        Phone: {selectedTaskCallOptions[0]?.value}
                      </Text>
                    ) : (
                      <Text style={styles.modalMetaText}>No phone available</Text>
                    )}
                    {selectedTaskCallOptions.length > 0 ? (
                      <View style={styles.inlineCallList}>
                        {selectedTaskCallOptions.map((option, index) => (
                          <TouchableOpacity
                            key={`${option.label}-${option.value}-${index}`}
                            style={styles.inlineCallChip}
                            onPress={() => void dialSelectedNumber(option.value)}
                            disabled={Boolean(dialingNumber)}>
                            <Feather name="phone-call" size={12} color="#075985" />
                            <Text style={styles.inlineCallChipText} numberOfLines={1}>
                              {option.label}: {option.value}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    ) : null}
                    {selectedTask?.email ? (
                      <Text style={styles.modalMetaText}>Email: {selectedTask.email}</Text>
                    ) : null}
                    {selectedTask?.contactSocials ? (
                      <Text style={styles.modalMetaText}>
                        Socials: {selectedTask.contactSocials}
                      </Text>
                    ) : null}
                    {selectedTask?.contactLinkedinUrl ? (
                      <TouchableOpacity
                        style={styles.modalMetaLink}
                        onPress={() =>
                          void openUrlSafely(
                            selectedTask.contactLinkedinUrl || '',
                            'Unable to open LinkedIn link.'
                          )
                        }>
                        <Feather name="link-2" size={12} color="#0369A1" />
                        <Text style={styles.modalMetaLinkText}>Contact LinkedIn</Text>
                      </TouchableOpacity>
                    ) : null}
                    {selectedTask?.department ? (
                      <Text style={styles.modalMetaText}>
                        Department: {selectedTask.department}
                      </Text>
                    ) : null}
                    {selectedTask?.seniority ? (
                      <Text style={styles.modalMetaText}>Seniority: {selectedTask.seniority}</Text>
                    ) : null}
                    {selectedTask?.listItems?.length ? (
                      <Text style={styles.modalMetaText}>
                        Lists: {listLabel(selectedTask.listItems)}
                      </Text>
                    ) : null}
                  </View>
                ) : null}

                {/* ── Location & Links (collapsed) ── */}
                <TouchableOpacity
                  style={accStyles.header}
                  onPress={() => setSectionLocationOpen((p) => !p)}
                  activeOpacity={0.7}>
                  <View style={accStyles.headerLeft}>
                    <View style={[accStyles.icon, { backgroundColor: '#D1FAE5' }]}>
                      <Feather name="map-pin" size={13} color="#059669" />
                    </View>
                    <Text style={accStyles.headerText}>Location & Links</Text>
                  </View>
                  <Feather
                    name={sectionLocationOpen ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color="#6B7280"
                  />
                </TouchableOpacity>
                {sectionLocationOpen ? (
                  <View style={accStyles.body}>
                    {selectedTask?.contactLocation ? (
                      <Text style={styles.modalMetaText}>
                        Contact Location: {selectedTask.contactLocation}
                      </Text>
                    ) : null}
                    {selectedTask?.companyLocation ? (
                      <Text style={styles.modalMetaText}>
                        Company Location: {selectedTask.companyLocation}
                      </Text>
                    ) : null}
                    {selectedTask?.quadrant ? (
                      <Text style={styles.modalMetaText}>
                        Quadrant: {selectedTask.quadrant.toUpperCase()}
                      </Text>
                    ) : null}
                    {selectedTask?.specialization ? (
                      <Text style={styles.modalMetaText}>
                        Specialization: {specializationLabel(selectedTask.specialization)}
                      </Text>
                    ) : null}
                    {selectedTask?.companyPostCode ? (
                      <Text style={styles.modalMetaText}>
                        Post Code: {selectedTask.companyPostCode}
                      </Text>
                    ) : null}
                    {selectedTask?.website ? (
                      <Text style={styles.modalMetaText}>Website: {selectedTask.website}</Text>
                    ) : null}
                    {selectedTask?.companyWebsiteDomain ? (
                      <Text style={styles.modalMetaText}>
                        Domain: {selectedTask.companyWebsiteDomain}
                      </Text>
                    ) : null}
                    {selectedTask?.companyLinkedinUrl ? (
                      <TouchableOpacity
                        style={styles.modalMetaLink}
                        onPress={() =>
                          void openUrlSafely(
                            selectedTask.companyLinkedinUrl || '',
                            'Unable to open LinkedIn link.'
                          )
                        }>
                        <Feather name="link-2" size={12} color="#0369A1" />
                        <Text style={styles.modalMetaLinkText}>Company LinkedIn</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                ) : null}

                {/* ── Company Details (collapsed) ── */}
                <TouchableOpacity
                  style={accStyles.header}
                  onPress={() => setSectionCompanyOpen((p) => !p)}
                  activeOpacity={0.7}>
                  <View style={accStyles.headerLeft}>
                    <View style={[accStyles.icon, { backgroundColor: '#FEF3C7' }]}>
                      <Feather name="briefcase" size={13} color="#B45309" />
                    </View>
                    <Text style={accStyles.headerText}>Company Details</Text>
                  </View>
                  <Feather
                    name={sectionCompanyOpen ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color="#6B7280"
                  />
                </TouchableOpacity>
                {sectionCompanyOpen ? (
                  <View style={accStyles.body}>
                    {selectedTask?.companyDescription ? (
                      <Text style={styles.modalMetaText}>
                        Description: {selectedTask.companyDescription}
                      </Text>
                    ) : null}
                    {selectedTask?.researchDate ? (
                      <Text style={styles.modalMetaText}>
                        Research Date: {formatDate(selectedTask.researchDate)}
                      </Text>
                    ) : null}
                    {typeof selectedTask?.companyAnnualRevenue === 'number' ? (
                      <Text style={styles.modalMetaText}>
                        Annual Revenue: {formatNumberValue(selectedTask.companyAnnualRevenue)}
                      </Text>
                    ) : null}
                    {selectedTask?.companyRevenueRange ? (
                      <Text style={styles.modalMetaText}>
                        Revenue Range: {selectedTask.companyRevenueRange}
                      </Text>
                    ) : null}
                    {typeof selectedTask?.companyStaffCount === 'number' ? (
                      <Text style={styles.modalMetaText}>
                        Staff Count: {formatNumberValue(selectedTask.companyStaffCount)}
                      </Text>
                    ) : null}
                    {selectedTask?.companyStaffCountRange ? (
                      <Text style={styles.modalMetaText}>
                        Staff Count Range: {selectedTask.companyStaffCountRange}
                      </Text>
                    ) : null}
                    {selectedTask?.companyFoundedDate ? (
                      <Text style={styles.modalMetaText}>
                        Founded: {formatDate(selectedTask.companyFoundedDate)}
                      </Text>
                    ) : null}
                    {selectedTask?.sicCode ? (
                      <Text style={styles.modalMetaText}>SIC: {selectedTask.sicCode}</Text>
                    ) : null}
                    {selectedTask?.naicsCode ? (
                      <Text style={styles.modalMetaText}>NAICS: {selectedTask.naicsCode}</Text>
                    ) : null}
                  </View>
                ) : null}

                {/* ── Imported Data (collapsed) ── */}
                {selectedTaskImportEntries.length > 0 ? (
                  <>
                    <TouchableOpacity
                      style={accStyles.header}
                      onPress={() => setSectionImportOpen((p) => !p)}
                      activeOpacity={0.7}>
                      <View style={accStyles.headerLeft}>
                        <View style={[accStyles.icon, { backgroundColor: '#F3E8FF' }]}>
                          <Feather name="database" size={13} color="#7C3AED" />
                        </View>
                        <Text style={accStyles.headerText}>
                          Imported Fields ({selectedTaskImportEntries.length})
                        </Text>
                      </View>
                      <Feather
                        name={sectionImportOpen ? 'chevron-up' : 'chevron-down'}
                        size={16}
                        color="#6B7280"
                      />
                    </TouchableOpacity>
                    {sectionImportOpen ? (
                      <View style={styles.importDataWrap}>
                        {selectedTaskImportEntries.map(([key, value]) => (
                          <View key={key} style={styles.importDataItem}>
                            <Text style={styles.importDataLabel}>
                              {toReadableImportFieldLabel(key)}
                            </Text>
                            <Text style={styles.importDataValue}>
                              {formatImportFieldValue(value)}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </>
                ) : null}

                <Text style={styles.modalSectionLabel}>Status</Text>
                <View style={[styles.statusGrid, isVeryCompact && styles.statusGridVeryCompact]}>
                  {CRM_STATUSES.map((status) => (
                    <TouchableOpacity
                      key={status}
                      accessibilityRole="radio"
                      accessibilityLabel={`Task status: ${statusText(status)}`}
                      accessibilityState={{ selected: updateStatus === status }}
                      style={[
                        styles.statusOption,
                        isVeryCompact && styles.statusOptionVeryCompact,
                        updateStatus === status && styles.statusOptionActive,
                      ]}
                      onPress={() => setUpdateStatus(status)}>
                      <Text
                        style={[
                          styles.statusOptionText,
                          isVeryCompact && styles.statusOptionTextVeryCompact,
                          updateStatus === status && styles.statusOptionTextActive,
                        ]}>
                        {statusText(status)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {updateStatus === 'lost' ? (
                  <>
                    <Text style={styles.modalSectionLabel}>Lost Reason</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.timelineEditStatusRow}>
                      {LOST_REASON_OPTIONS.map((option) => (
                        <TouchableOpacity
                          key={option.key}
                          style={[
                            styles.timelineEditStatusChip,
                            updateLostReason === option.key && styles.timelineEditStatusChipActive,
                          ]}
                          onPress={() => setUpdateLostReason(option.key)}>
                          <Text
                            style={[
                              styles.timelineEditStatusText,
                              updateLostReason === option.key && styles.timelineEditStatusTextActive,
                            ]}>
                            {option.label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </>
                ) : null}

                {/* Follow-up date (owner decision 2026-10-11). Won and Lost end it. */}
                {updateStatus !== 'won' && updateStatus !== 'lost' ? (
                  <CrmFollowUpPicker value={followUpDraft} onChange={setFollowUpDraft} disabled={submitting} />
                ) : null}

                <View style={styles.autoReminderCard}>
                  <Feather name="clock" size={14} color="#0369A1" />
                  <Text style={styles.autoReminderText}>
                    {followUpDraft.date && updateStatus !== 'won' && updateStatus !== 'lost'
                      ? followUpReminderText(followUpDraft.date, followUpDraft.time, new Date(), followUpReminderSentFor(selectedTask, followUpDraft))
                      : autoReminderText(updateStatus, updateLostReason)}
                  </Text>
                </View>

                <View style={styles.commentHeaderRow}>
                  <Text style={styles.modalSectionLabel}>Comment</Text>
                  <TouchableOpacity
                    style={[
                      styles.commentVoiceBtn,
                      commentRecording ? styles.commentVoiceBtnActive : null,
                      transcribingComment ? styles.commentVoiceBtnBusy : null,
                    ]}
                    onPress={() => void toggleCommentRecording()}
                    disabled={voiceBusy || transcribingComment || submitting}>
                    {transcribingComment ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Feather
                        name={commentRecording ? 'stop-circle' : 'mic'}
                        size={14}
                        color="#fff"
                      />
                    )}
                    <Text style={styles.commentVoiceBtnText}>
                      {transcribingComment
                        ? 'Transcribing...'
                        : commentRecording
                          ? `Stop (${formatDurationMs(commentRecordingDurationMs)})`
                          : 'Voice'}
                    </Text>
                  </TouchableOpacity>
                </View>
                <TextInput
                  style={[styles.commentInput, isVeryCompact && styles.commentInputVeryCompact]}
                  value={comment}
                  accessibilityLabel="Task comment"
                  onChangeText={setComment}
                  placeholder="Add call notes or update details"
                  placeholderTextColor="#9CA3AF"
                  multiline
                  numberOfLines={4}
                />

                <View style={[styles.modalActionsRow, isVeryCompact && styles.modalActionsRowVeryCompact]}>
                  <TouchableOpacity style={[styles.fileBtn, isVeryCompact && styles.fileBtnVeryCompact]} onPress={pickAttachments}>
                    <Feather name="paperclip" size={isVeryCompact ? 13 : 15} color="#0369A1" />
                    <Text style={[styles.fileBtnText, isVeryCompact && styles.fileBtnTextVeryCompact]}>Attachments ({attachments.length})</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.fileBtn, isVeryCompact && styles.fileBtnVeryCompact]} onPress={pickGalleryImages}>
                    <Feather name="image" size={isVeryCompact ? 13 : 15} color="#0369A1" />
                    <Text style={[styles.fileBtnText, isVeryCompact && styles.fileBtnTextVeryCompact]}>Gallery</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.fileBtn, isVeryCompact && styles.fileBtnVeryCompact]} onPress={pickRecording}>
                    <Feather name="mic" size={isVeryCompact ? 13 : 15} color="#0369A1" />
                    <Text style={[styles.fileBtnText, isVeryCompact && styles.fileBtnTextVeryCompact]}>
                      {recording ? 'Recording Selected' : 'Add Recording'}
                    </Text>
                  </TouchableOpacity>
                </View>

                {attachments.length > 0 ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.attachmentRow}>
                    {attachments.map((file, index) => (
                      <View key={`${file.uri}-${index}`} style={styles.attachmentTag}>
                        <Text style={styles.attachmentTagText} numberOfLines={1}>
                          {file.name}
                        </Text>
                        <TouchableOpacity
                          onPress={() =>
                            setAttachments((prev) => prev.filter((_, i) => i !== index))
                          }
                          style={styles.attachmentRemoveBtn}>
                          <Feather name="x" size={12} color="#fff" />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </ScrollView>
                ) : null}

                <TouchableOpacity
                  style={accStyles.header}
                  onPress={() => setSectionTimelineOpen((p) => !p)}
                  activeOpacity={0.7}>
                  <View style={accStyles.headerLeft}>
                    <View style={[accStyles.icon, { backgroundColor: '#D1FAE5' }]}>
                      <Feather name="clock" size={13} color="#0F766E" />
                    </View>
                    <Text style={accStyles.headerText}>
                      Activity Timeline ({modalUpdates.length})
                    </Text>
                  </View>
                  <Feather
                    name={sectionTimelineOpen ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color="#6B7280"
                  />
                </TouchableOpacity>
                {sectionTimelineOpen && modalUpdates.length === 0 ? (
                  <Text style={styles.timelineEmptyText}>No activity yet for this lead.</Text>
                ) : null}
                {sectionTimelineOpen && modalUpdates.length > 0 ? (
                  <View style={styles.timelineList}>
                    {modalUpdates.map((update, index) => {
                      const updateId = normalizeUpdateId(update._id);
                      return (
                        <View
                          key={updateId || `${update.createdAt || 'entry'}-${index}`}
                          style={styles.timelineCard}>
                          <View style={styles.timelineTopRow}>
                            <Text style={styles.timelineAuthor}>
                              {updateCreatorLabel(update.createdBy)}
                            </Text>
                            <Text style={styles.timelineDate}>
                              {formatDateTime(update.createdAt)}
                            </Text>
                          </View>

                          <Text style={styles.timelineStatusText}>
                            Status:{' '}
                            {statusText(
                              (update.status || selectedTask?.status || 'new_lead') as CrmTaskStatus
                            )}
                            {update.lostReason ? ` • ${lostReasonText(update.lostReason)}` : ''}
                          </Text>

                          <View style={styles.timelineMetaRow}>
                            {update.editedAt && !update.isDeleted ? (
                              <Text style={styles.timelineEditedBadge}>Edited</Text>
                            ) : null}
                            {update.isDeleted ? (
                              <Text style={styles.timelineDeletedBadge}>Deleted</Text>
                            ) : null}
                          </View>

                          {update.isDeleted ? (
                            <Text style={styles.timelineDeletedText}>This update was deleted.</Text>
                          ) : null}

                          {!update.isDeleted && editingUpdateId === updateId ? (
                            <View style={styles.timelineEditBox}>
                              <TextInput
                                style={styles.timelineEditInput}
                                value={editingComment}
                                onChangeText={setEditingComment}
                                placeholder="Edit message"
                                accessibilityLabel="Edit activity message"
                                placeholderTextColor="#94A3B8"
                                multiline
                              />
                              <ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                contentContainerStyle={styles.timelineEditStatusRow}>
                                {CRM_STATUSES.map((status) => (
                                  <TouchableOpacity
                                    key={`${updateId}-${status}`}
                                    style={[
                                      styles.timelineEditStatusChip,
                                      editingStatus === status &&
                                        styles.timelineEditStatusChipActive,
                                    ]}
                                    onPress={() => setEditingStatus(status)}>
                                    <Text
                                      style={[
                                        styles.timelineEditStatusText,
                                        editingStatus === status &&
                                          styles.timelineEditStatusTextActive,
                                      ]}>
                                      {statusText(status)}
                                    </Text>
                                  </TouchableOpacity>
                                ))}
                              </ScrollView>
                              {editingStatus === 'lost' ? (
                                <ScrollView
                                  horizontal
                                  showsHorizontalScrollIndicator={false}
                                  contentContainerStyle={styles.timelineEditStatusRow}>
                                  {LOST_REASON_OPTIONS.map((option) => (
                                    <TouchableOpacity
                                      key={`${updateId}-lost-${option.key}`}
                                      style={[
                                        styles.timelineEditStatusChip,
                                        editingLostReason === option.key &&
                                          styles.timelineEditStatusChipActive,
                                      ]}
                                      onPress={() => setEditingLostReason(option.key)}>
                                      <Text
                                        style={[
                                          styles.timelineEditStatusText,
                                          editingLostReason === option.key &&
                                            styles.timelineEditStatusTextActive,
                                        ]}>
                                        {option.label}
                                      </Text>
                                    </TouchableOpacity>
                                  ))}
                                </ScrollView>
                              ) : null}
                              <View style={styles.timelineActionRow}>
                                <TouchableOpacity
                                  style={[styles.timelineActionBtn, styles.timelineCancelBtn]}
                                  onPress={cancelEditUpdate}
                                  disabled={timelineBusyKey === `edit:${updateId}`}>
                                  <Text style={styles.timelineCancelBtnText}>Cancel</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                  style={[styles.timelineActionBtn, styles.timelineSaveBtn]}
                                  onPress={() => void saveEditUpdate(update)}
                                  disabled={timelineBusyKey === `edit:${updateId}`}>
                                  {timelineBusyKey === `edit:${updateId}` ? (
                                    <ActivityIndicator size="small" color="#fff" />
                                  ) : (
                                    <Text style={styles.timelineSaveBtnText}>Save</Text>
                                  )}
                                </TouchableOpacity>
                              </View>
                            </View>
                          ) : null}

                          {!update.isDeleted && update.comment ? (
                            <Text style={styles.timelineComment}>{update.comment}</Text>
                          ) : null}

                          {!update.isDeleted &&
                          String(update.createdBy?._id || '') === String(user?._id || '') &&
                          editingUpdateId !== updateId ? (
                            <View style={styles.timelineActionRow}>
                              <TouchableOpacity
                                style={[styles.timelineActionBtn, styles.timelineActionSecondary]}
                                onPress={() => beginEditUpdate(update)}
                                disabled={Boolean(timelineBusyKey)}>
                                <Text style={styles.timelineActionSecondaryText}>Edit</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={[styles.timelineActionBtn, styles.timelineActionDanger]}
                                onPress={() => void deleteUpdate(update)}
                                disabled={timelineBusyKey === `delete:${updateId}`}>
                                {timelineBusyKey === `delete:${updateId}` ? (
                                  <ActivityIndicator size="small" color="#fff" />
                                ) : (
                                  <Text style={styles.timelineActionDangerText}>Delete</Text>
                                )}
                              </TouchableOpacity>
                            </View>
                          ) : null}

                          {!update.isDeleted && update.attachmentUrls?.length ? (
                            <View style={styles.timelineAttachmentWrap}>
                              {update.attachmentUrls.map((url, attachmentIndex) => (
                                <View
                                  key={`${url}-${attachmentIndex}`}
                                  style={styles.timelineAttachmentItem}>
                                  <TouchableOpacity
                                    style={styles.timelineAttachmentBtn}
                                    onPress={() =>
                                      void openUrlSafely(url, 'Unable to open attachment.')
                                    }>
                                    {isLikelyImageAttachment(url) ? (
                                      <Image
                                        source={{ uri: url }}
                                        style={styles.timelineAttachmentImage}
                                        resizeMode="cover"
                                      />
                                    ) : (
                                      <>
                                        <Feather name="paperclip" size={12} color="#0C4A6E" />
                                        <Text style={styles.timelineAttachmentText}>
                                          Attachment {attachmentIndex + 1}
                                        </Text>
                                      </>
                                    )}
                                  </TouchableOpacity>
                                  {String(update.createdBy?._id || '') ===
                                  String(user?._id || '') ? (
                                    <TouchableOpacity
                                      style={styles.timelineMediaDeleteBtn}
                                      onPress={() => void deleteUpdateAttachment(update, url)}
                                      disabled={
                                        timelineBusyKey === `attachment:${updateId}:${url}`
                                      }>
                                      {timelineBusyKey === `attachment:${updateId}:${url}` ? (
                                        <ActivityIndicator size="small" color="#fff" />
                                      ) : (
                                        <Text style={styles.timelineMediaDeleteBtnText}>
                                          Remove
                                        </Text>
                                      )}
                                    </TouchableOpacity>
                                  ) : null}
                                </View>
                              ))}
                            </View>
                          ) : null}

                          {!update.isDeleted && update.recordingUrl ? (
                            <View style={styles.timelineRecordingWrap}>
                              <TouchableOpacity
                                style={styles.timelineRecordingBtn}
                                onPress={() => void toggleRecordingPlayback(update.recordingUrl)}>
                                {recordingPlaybackLoadingUrl === update.recordingUrl ? (
                                  <ActivityIndicator size="small" color="#075985" />
                                ) : (
                                  <Feather
                                    name={
                                      playingRecordingUrl === update.recordingUrl
                                        ? 'square'
                                        : 'play-circle'
                                    }
                                    size={14}
                                    color="#075985"
                                  />
                                )}
                                <Text style={styles.timelineRecordingText}>
                                  {recordingPlaybackLoadingUrl === update.recordingUrl
                                    ? 'Loading voice note...'
                                    : playingRecordingUrl === update.recordingUrl
                                      ? 'Stop voice note'
                                      : 'Play voice note'}
                                </Text>
                              </TouchableOpacity>
                              {String(update.createdBy?._id || '') === String(user?._id || '') ? (
                                <TouchableOpacity
                                  style={styles.timelineMediaDeleteBtn}
                                  onPress={() => void deleteUpdateRecording(update)}
                                  disabled={timelineBusyKey === `recording:${updateId}`}>
                                  {timelineBusyKey === `recording:${updateId}` ? (
                                    <ActivityIndicator size="small" color="#fff" />
                                  ) : (
                                    <Text style={styles.timelineMediaDeleteBtnText}>
                                      Delete audio
                                    </Text>
                                  )}
                                </TouchableOpacity>
                              ) : null}
                            </View>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                ) : null}

                <View style={[styles.modalFooterRow, isVeryCompact && styles.modalFooterRowVeryCompact]}>
                  <TouchableOpacity
                    style={styles.cancelBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel task update"
                    accessibilityState={{ disabled: submitting }}
                    onPress={() => closeUpdateModal()}
                    disabled={submitting}>
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.submitBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Submit task update"
                    accessibilityState={{ disabled: submitting, busy: submitting }}
                    onPress={submitUpdate}
                    disabled={submitting}>
                    {submitting ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <Text style={styles.submitBtnText}>Submit</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
        </CrmModalFrame>
      </Modal>

      <Modal
        visible={emailModalVisible}
        transparent
        animationType="slide"
        onRequestClose={closeEmailModal}>
        <CrmModalFrame label="Compose email form" onClose={closeEmailModal}
          cardStyle={[styles.modalCard, isCompact && styles.modalCardCompact]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Compose Email</Text>
                <TouchableOpacity
                  onPress={closeEmailModal}
                  accessibilityRole="button"
                  accessibilityLabel="Close email"
                  accessibilityState={{ disabled: emailRewriting || emailTranscribing }}
                  style={crmTouchTarget}
                  disabled={emailRewriting || emailTranscribing}>
                  <Feather name="x" size={20} color="#6B7280" />
                </TouchableOpacity>
              </View>

              <View style={[styles.modalBodyScroll, styles.modalBodyContent]}>
                <Text style={styles.modalClientName}>
                  To: {emailTask?.clientName || 'Client'} {emailTo ? `<${emailTo}>` : '(no email)'}
                </Text>

                <Text style={emailStyles.fieldLabel}>Recipient Email</Text>
                <TextInput
                  style={emailStyles.fieldInput}
                  value={emailTo}
                  accessibilityLabel="Recipient email"
                  onChangeText={setEmailTo}
                  placeholder="recipient@email.com"
                  placeholderTextColor="#9CA3AF"
                  keyboardType="email-address"
                  autoCapitalize="none"
                />

                <Text style={emailStyles.fieldLabel}>Subject</Text>
                <TextInput
                  style={emailStyles.fieldInput}
                  value={emailSubject}
                  accessibilityLabel="Email subject"
                  onChangeText={setEmailSubject}
                  placeholder="Email subject (or leave blank for Software to generate)"
                  placeholderTextColor="#9CA3AF"
                />

                <View style={emailStyles.bodyHeaderRow}>
                  <Text style={emailStyles.fieldLabel}>Body</Text>
                  <View style={emailStyles.toolRow}>
                    {emailIsHtml && (
                      <TouchableOpacity
                        style={[
                          emailStyles.toolBtn,
                          isVeryCompact && emailStyles.toolBtnVeryCompact,
                          emailPreviewMode ? htmlStyles.toolBtnEdit : htmlStyles.toolBtnPreview,
                        ]}
                        onPress={toggleEmailEditPreview}>
                        <Feather
                          name={emailPreviewMode ? 'edit-2' : 'eye'}
                          size={isVeryCompact ? 12 : 14}
                          color="#fff"
                        />
                        <Text style={[emailStyles.toolBtnText, isVeryCompact && emailStyles.toolBtnTextVeryCompact]}>
                          {emailPreviewMode ? 'Edit' : 'Preview'}
                        </Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[
                        emailStyles.toolBtn,
                        isVeryCompact && emailStyles.toolBtnVeryCompact,
                        emailRecording ? emailStyles.toolBtnRecording : null,
                        emailTranscribing ? emailStyles.toolBtnBusy : null,
                      ]}
                      onPress={() => void toggleEmailVoiceRecording()}
                      disabled={emailVoiceBusy || emailTranscribing || emailRewriting}>
                      {emailTranscribing ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Feather
                          name={emailRecording ? 'stop-circle' : 'mic'}
                          size={isVeryCompact ? 12 : 14}
                          color="#fff"
                        />
                      )}
                      <Text style={[emailStyles.toolBtnText, isVeryCompact && emailStyles.toolBtnTextVeryCompact]}>
                        {emailTranscribing
                          ? 'Transcribing...'
                          : emailRecording
                            ? `Stop (${formatDurationMs(emailRecordingDurationMs)})`
                            : 'Voice'}
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[emailStyles.toolBtn, isVeryCompact && emailStyles.toolBtnVeryCompact, emailStyles.toolBtnAI]}
                      onPress={() => void rewriteEmailAI()}
                      disabled={emailRewriting || emailTranscribing || !emailBody.trim()}>
                      {emailRewriting ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Feather name="zap" size={isVeryCompact ? 12 : 14} color="#fff" />
                      )}
                      <Text style={[emailStyles.toolBtnText, isVeryCompact && emailStyles.toolBtnTextVeryCompact]}>
                        {emailRewriting ? 'Rewriting...' : 'Software Rewrite'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {emailIsHtml && emailPreviewMode ? (
                  <View style={htmlStyles.htmlPreviewWrap}>
                    <WebView
                      originWhitelist={['*']}
                      source={{
                        html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/><style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1F2937;padding:12px;background:#FAFBFC;}p{margin-bottom:10px;}strong,b{font-weight:700;color:#0F172A;}em{font-style:italic;}u{text-decoration:underline;}ul,ol{margin:8px 0 8px 18px;}li{margin-bottom:4px;}a{color:#2563EB;text-decoration:none;}</style></head><body>${emailHtmlBody}</body></html>`,
                      }}
                      style={htmlStyles.htmlPreview}
                      scrollEnabled={true}
                      nestedScrollEnabled={true}
                      showsVerticalScrollIndicator={false}
                      scalesPageToFit={false}
                    />
                    <TouchableOpacity
                      style={htmlStyles.htmlPreviewEditHint}
                      onPress={toggleEmailEditPreview}
                      activeOpacity={0.7}>
                      <Feather name="edit-2" size={12} color="#6B7280" />
                      <Text style={htmlStyles.htmlPreviewEditHintText}>Tap &quot;Edit&quot; to modify</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TextInput
                    style={[emailStyles.bodyInput, isVeryCompact && emailStyles.bodyInputVeryCompact]}
                    value={emailBody}
                    accessibilityLabel="Email message"
                    onChangeText={setEmailBody}
                    placeholder="Type your email body or use voice to dictate..."
                    placeholderTextColor="#9CA3AF"
                    multiline
                    numberOfLines={6}
                    textAlignVertical="top"
                  />
                )}

                <View style={emailStyles.senderInfo}>
                  <Feather name="user" size={13} color="#6B7280" />
                  <Text style={emailStyles.senderText}>
                    From: {user?.username || user?.email?.split('@')[0] || 'You'}
                    {user?.companyName ? ` • ${user.companyName}` : ''}
                    {user?.contactEmail ? ` • ${user.contactEmail}` : ''}
                  </Text>
                </View>

                <View style={styles.modalFooterRow}>
                  <TouchableOpacity
                    style={styles.cancelBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel email"
                    accessibilityState={{ disabled: emailRewriting || emailTranscribing }}
                    onPress={closeEmailModal}
                    disabled={emailRewriting || emailTranscribing}>
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.submitBtn, emailStyles.sendBtn]}
                    accessibilityRole="button"
                    accessibilityLabel="Send email"
                    accessibilityState={{ disabled: emailRewriting || emailTranscribing || !emailTo.trim() }}
                    onPress={() => void sendEmail()}
                    disabled={emailRewriting || emailTranscribing || !emailTo.trim()}>
                    <Feather name="send" size={16} color="#fff" />
                    <Text style={styles.submitBtnText}>Send Email</Text>
                  </TouchableOpacity>
                </View>
              </View>
        </CrmModalFrame>
      </Modal>

      <Modal
        visible={emailClientChooserVisible}
        transparent
        animationType="fade"
        onRequestClose={closeEmailClientChooser}>
        <CrmModalFrame label="Choose email application" onClose={closeEmailClientChooser} cardStyle={chooserStyles.card}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Open Email With</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close email application chooser" style={crmTouchTarget} onPress={closeEmailClientChooser}>
                <Feather name="x" size={20} color="#6B7280" />
              </TouchableOpacity>
            </View>
            <Text style={chooserStyles.subtitle}>Choose your preferred email app</Text>
            <View style={chooserStyles.optionList}>
              <TouchableOpacity
                style={chooserStyles.option}
                onPress={() => void openWithGmail()}
                activeOpacity={0.7}>
                <View style={[chooserStyles.iconWrap, { backgroundColor: '#FEE2E2' }]}>
                  <FontAwesome name="google" size={22} color="#EA4335" />
                </View>
                <View style={chooserStyles.optionTextWrap}>
                  <Text style={chooserStyles.optionTitle}>Gmail</Text>
                  <Text style={chooserStyles.optionDesc}>Open in Google Gmail app</Text>
                </View>
                <Feather name="chevron-right" size={18} color="#9CA3AF" />
              </TouchableOpacity>
              <TouchableOpacity
                style={chooserStyles.option}
                onPress={() => void openWithOutlook()}
                activeOpacity={0.7}>
                <View style={[chooserStyles.iconWrap, { backgroundColor: '#DBEAFE' }]}>
                  <FontAwesome name="windows" size={22} color="#0078D4" />
                </View>
                <View style={chooserStyles.optionTextWrap}>
                  <Text style={chooserStyles.optionTitle}>Outlook</Text>
                  <Text style={chooserStyles.optionDesc}>Open in Microsoft Outlook app</Text>
                </View>
                <Feather name="chevron-right" size={18} color="#9CA3AF" />
              </TouchableOpacity>
              <TouchableOpacity
                style={chooserStyles.option}
                onPress={() => void openWithDefaultMail()}
                activeOpacity={0.7}>
                <View style={[chooserStyles.iconWrap, { backgroundColor: '#E0F2FE' }]}>
                  <Feather name="mail" size={22} color="#0284C7" />
                </View>
                <View style={chooserStyles.optionTextWrap}>
                  <Text style={chooserStyles.optionTitle}>Default Mail</Text>
                  <Text style={chooserStyles.optionDesc}>Open in device default mail app</Text>
                </View>
                <Feather name="chevron-right" size={18} color="#9CA3AF" />
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={chooserStyles.cancelBtn} onPress={closeEmailClientChooser}>
              <Text style={chooserStyles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
        </CrmModalFrame>
      </Modal>

      <Modal
        visible={calendarSyncModalVisible}
        transparent
        animationType="fade"
        onRequestClose={closeCalendarSyncModal}>
        <CrmModalFrame label="Calendar task selection" onClose={closeCalendarSyncModal}
          cardStyle={[styles.calendarSyncModalCard, isCompact && styles.transferModalCardCompact, isVeryCompact && styles.calendarSyncModalCardVeryCompact]}>
            <View style={styles.modalHeader}>
              <View style={styles.calendarSyncHeaderTextWrap}>
                <Text style={styles.modalTitle}>Sync Tasks to Calendar</Text>
                <Text style={styles.calendarSyncSummaryText}>
                  {calendarSyncSelectedCount} selected of {tasks.length}
                </Text>
              </View>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close calendar sync" accessibilityState={{ disabled: outlookBulkSyncing }} style={crmTouchTarget} onPress={closeCalendarSyncModal} disabled={outlookBulkSyncing}>
                <Feather name="x" size={20} color="#6B7280" />
              </TouchableOpacity>
            </View>

            <View style={styles.calendarSyncSearchRow}>
              <Feather name="search" size={16} color="#92400E" />
              <TextInput
                style={styles.calendarSyncSearchInput}
                value={calendarSyncSearchText}
                accessibilityLabel="Search calendar tasks"
                onChangeText={setCalendarSyncSearchText}
                placeholder="Search client, company, email, phone"
                placeholderTextColor="#9CA3AF"
                editable={!outlookBulkSyncing}
              />
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.calendarSyncFilterRow}>
              {STATUS_OPTIONS.map((option) => {
                const active = calendarSyncStatusFilter === option.key;
                return (
                  <TouchableOpacity
                    key={`calendar-sync-${option.key}`}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected: active, disabled: outlookBulkSyncing }}
                    style={[
                      styles.calendarSyncFilterChip,
                      active && styles.calendarSyncFilterChipActive,
                    ]}
                    onPress={() => setCalendarSyncStatusFilter(option.key)}
                    disabled={outlookBulkSyncing}>
                    <Text
                      style={[
                        styles.calendarSyncFilterChipText,
                        active && styles.calendarSyncFilterChipTextActive,
                      ]}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <View style={styles.calendarSyncQuickActions}>
              <TouchableOpacity
                style={styles.calendarSyncQuickBtn}
                onPress={markFilteredCalendarSyncTasks}
                disabled={outlookBulkSyncing || calendarSyncFilteredTasks.length === 0}>
                <Text style={styles.calendarSyncQuickBtnText}>Mark Filtered</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.calendarSyncQuickBtn, styles.calendarSyncQuickBtnClear]}
                onPress={clearFilteredCalendarSyncTasks}
                disabled={outlookBulkSyncing || calendarSyncFilteredTasks.length === 0}>
                <Text style={styles.calendarSyncQuickBtnText}>Clear Filtered</Text>
              </TouchableOpacity>
            </View>

            {calendarSyncFilteredTasks.length === 0 ? (
              <View style={styles.calendarSyncEmptyWrap}>
                <Feather name="calendar" size={24} color="#94A3B8" />
                <Text style={styles.emptySubtitle}>No tasks match the current search or filter.</Text>
              </View>
            ) : (
              <ScrollView style={styles.calendarSyncTaskList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                {calendarSyncFilteredTasks.map((task) => {
                  const selected = calendarSyncSelectedTaskIds.includes(task._id);
                  const badge = getStatusBadge(task.status);
                  return (
                    <TouchableOpacity
                      key={`calendar-sync-row-${task._id}`}
                      accessibilityRole="checkbox"
                      accessibilityLabel={task.clientName || 'Client'}
                      accessibilityState={{ checked: selected, disabled: outlookBulkSyncing }}
                      style={[
                        styles.calendarSyncTaskRow,
                        selected && styles.calendarSyncTaskRowSelected,
                      ]}
                      onPress={() => toggleCalendarSyncTask(task._id)}
                      disabled={outlookBulkSyncing}>
                      <View
                        style={[
                          styles.calendarSyncCheckbox,
                          selected && styles.calendarSyncCheckboxSelected,
                        ]}>
                        {selected ? <Feather name="check" size={14} color="#fff" /> : null}
                      </View>
                      <View style={styles.calendarSyncTaskBody}>
                        <View style={styles.calendarSyncTaskTopRow}>
                          <Text style={styles.calendarSyncTaskTitle} numberOfLines={1}>
                            {task.clientName || 'Client'}
                          </Text>
                          <View style={[styles.calendarSyncStatusBadge, { backgroundColor: badge.bg }]}>
                            <Text style={[styles.calendarSyncStatusBadgeText, { color: badge.text }]}>
                              {statusText(task.status)}
                            </Text>
                          </View>
                        </View>
                        <Text style={styles.calendarSyncTaskMeta} numberOfLines={1}>
                          {task.companyName || task.email || 'No company or email'}
                        </Text>
                        <Text style={styles.calendarSyncTaskMeta} numberOfLines={1}>
                          Due {formatDate(task.dueDate)}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            <View style={styles.modalFooterRow}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={closeCalendarSyncModal}
                disabled={outlookBulkSyncing}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.submitBtn,
                  styles.calendarSyncSubmitBtn,
                  (!outlookStatus.connected || calendarSyncSelectedCount === 0) &&
                    styles.calendarSyncSubmitBtnDisabled,
                ]}
                onPress={() => void syncSelectedTasksToOutlookCalendar()}
                disabled={!outlookStatus.connected || outlookBulkSyncing || calendarSyncSelectedCount === 0}>
                {outlookBulkSyncing ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.submitBtnText}>Sync Selected</Text>
                )}
              </TouchableOpacity>
            </View>
        </CrmModalFrame>
      </Modal>

      <Modal
        visible={transferModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => closeTransferModal()}>
        <CrmModalFrame label="Transfer task form" onClose={() => closeTransferModal()}
          cardStyle={[styles.transferModalCard, isCompact && styles.transferModalCardCompact, isVeryCompact && styles.transferModalCardVeryCompact]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Transfer Task</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close transfer task" accessibilityState={{ disabled: transferSubmitting }} style={crmTouchTarget} onPress={() => closeTransferModal()} disabled={transferSubmitting}>
                <Feather name="x" size={20} color="#6B7280" />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalClientName}>{transferTask?.clientName || 'Client'}</Text>
            <Text style={styles.modalMetaText}>
              Select a CRM agent to request transfer for this lead.
            </Text>

            <Text style={styles.modalSectionLabel}>Select Agent</Text>
            {transferAgentsLoading ? (
              <ActivityIndicator size="small" color="#0284C7" />
            ) : transferAgents.length === 0 ? (
              <Text style={styles.timelineEmptyText}>No CRM agents available for transfer.</Text>
            ) : (
              <ScrollView style={styles.transferAgentList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                {transferAgents.map((agent) => {
                  const selected = transferAgentId === agent._id;
                  return (
                    <TouchableOpacity
                      key={agent._id}
                      accessibilityRole="radio"
                      accessibilityLabel={crmUserLabel(agent)}
                      accessibilityState={{ selected }}
                      style={[
                        styles.transferAgentItem,
                        selected && styles.transferAgentItemActive,
                      ]}
                      onPress={() => setTransferAgentId(agent._id)}>
                      <Text
                        style={[
                          styles.transferAgentName,
                          selected && styles.transferAgentNameActive,
                        ]}>
                        {crmUserLabel(agent)}
                      </Text>
                      {(agent.crmAddress || agent.crmQuadrant || specializationLabels(agent.crmSpecializations).join(', ')) && (
                        <Text
                          style={[
                            styles.transferAgentMeta,
                            selected && styles.transferAgentMetaActive,
                          ]}
                          numberOfLines={2}>
                          {[
                            agent.crmAddress,
                            agent.crmQuadrant,
                            specializationLabels(agent.crmSpecializations).join(', '),
                          ]
                            .filter(Boolean)
                            .join(' • ')}
                        </Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            <Text style={styles.modalSectionLabel}>Note (optional)</Text>
            <TextInput
              style={styles.transferNoteInput}
              value={transferNote}
              accessibilityLabel="Transfer note"
              onChangeText={setTransferNote}
              placeholder="Write a quick note for the receiving agent"
              placeholderTextColor="#9CA3AF"
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              editable={!transferSubmitting}
            />

            <View style={styles.modalFooterRow}>
              <TouchableOpacity
                style={styles.cancelBtn}
                accessibilityRole="button"
                accessibilityLabel="Cancel task transfer"
                accessibilityState={{ disabled: transferSubmitting }}
                onPress={() => closeTransferModal()}
                disabled={transferSubmitting}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.submitBtn, styles.transferSendBtn]}
                accessibilityRole="button"
                accessibilityLabel="Send transfer request"
                accessibilityState={{ disabled: transferSubmitting || !transferAgentId, busy: transferSubmitting }}
                onPress={() => void submitTransferRequest()}
                disabled={transferSubmitting || !transferAgentId}>
                {transferSubmitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.submitBtnText}>Send Request</Text>
                )}
              </TouchableOpacity>
            </View>
        </CrmModalFrame>
      </Modal>

      <Modal
        visible={transferInboxVisible}
        transparent
        animationType="fade"
        onRequestClose={closeTransferInboxModal}>
        <CrmModalFrame label="Transfer requests" onClose={closeTransferInboxModal}
          cardStyle={[styles.callModalCard, isCompact && styles.callModalCardCompact, isVeryCompact && styles.callModalCardVeryCompact]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Transfer Inbox</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close transfer inbox" accessibilityState={{ disabled: Boolean(transferRespondingId) }} style={crmTouchTarget} onPress={closeTransferInboxModal} disabled={Boolean(transferRespondingId)}>
                <Feather name="x" size={20} color="#6B7280" />
              </TouchableOpacity>
            </View>

            {transferInboxLoading ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator size="small" color="#0284C7" />
              </View>
            ) : transferInbox.length === 0 ? (
              <View style={styles.emptyCard}>
                <Feather name="inbox" size={26} color="#94A3B8" />
                <Text style={styles.emptySubtitle}>No transfer requests found.</Text>
              </View>
            ) : (
              <ScrollView style={styles.inboxList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                {transferInbox.map((item) => {
                  const isPending = item.status === 'pending';
                  const busy = transferRespondingId === item._id;
                  return (
                    <View key={item._id} style={styles.inboxCard}>
                      <Text style={styles.inboxTitle} numberOfLines={1}>
                        {item.leadId?.clientName || 'Lead'}
                      </Text>
                      <Text style={styles.inboxMeta}>
                        From: {crmUserLabel(item.fromUserId)}
                      </Text>
                      <Text style={styles.inboxMeta}>
                        Created: {formatDateTime(item.createdAt)}
                      </Text>
                      {item.note ? (
                        <Text style={styles.inboxNote} numberOfLines={3}>
                          Note: {item.note}
                        </Text>
                      ) : null}

                      {isPending ? (
                        <View style={styles.inboxActionRow}>
                          <TouchableOpacity
                            style={[styles.inboxActionBtn, styles.inboxRejectBtn]}
                            onPress={() => void respondTransferRequest(item, 'reject')}
                            disabled={busy}>
                            <Text style={styles.inboxActionText}>Reject</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.inboxActionBtn, styles.inboxAcceptBtn]}
                            onPress={() => void respondTransferRequest(item, 'accept')}
                            disabled={busy}>
                            {busy ? (
                              <ActivityIndicator size="small" color="#fff" />
                            ) : (
                              <Text style={styles.inboxActionText}>Accept</Text>
                            )}
                          </TouchableOpacity>
                        </View>
                      ) : (
                        <View style={styles.inboxStatusTag}>
                          <Text style={styles.inboxStatusText}>{statusText(item.status as CrmTaskStatus)}</Text>
                        </View>
                      )}
                    </View>
                  );
                })}
              </ScrollView>
            )}
        </CrmModalFrame>
      </Modal>

      <Modal
        visible={callModalVisible}
        transparent
        animationType="fade"
        onRequestClose={closeCallModal}>
        <CrmModalFrame label="Choose phone number" onClose={closeCallModal}
          cardStyle={[styles.callModalCard, isCompact && styles.callModalCardCompact, isVeryCompact && styles.callModalCardVeryCompact]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Number to Call</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close phone numbers" accessibilityState={{ disabled: Boolean(dialingNumber) }} style={crmTouchTarget} onPress={closeCallModal} disabled={Boolean(dialingNumber)}>
                <Feather name="x" size={20} color="#6B7280" />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalClientName}>{callTargetTask?.clientName || 'Client'}</Text>
            {callTargetTask?.companyName ? (
              <Text style={styles.modalMetaText}>{callTargetTask.companyName}</Text>
            ) : null}

            <View style={styles.callOptionList}>
              {callOptions.map((option, index) => (
                <TouchableOpacity
                  key={`${option.label}-${option.value}-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Call ${option.label}: ${option.value}`}
                  accessibilityState={{ disabled: Boolean(dialingNumber), busy: dialingNumber === option.value }}
                  style={styles.callOptionBtn}
                  onPress={() => void dialSelectedNumber(option.value)}
                  disabled={Boolean(dialingNumber)}>
                  <View style={styles.callOptionBadge}>
                    <Text style={styles.callOptionBadgeText}>{option.label}</Text>
                  </View>
                  <Text style={styles.callOptionValue} numberOfLines={1}>
                    {option.value}
                  </Text>
                  {dialingNumber === option.value ? (
                    <ActivityIndicator size="small" color="#0284C7" />
                  ) : (
                    <Feather name="phone-call" size={15} color="#0284C7" />
                  )}
                </TouchableOpacity>
              ))}
            </View>
        </CrmModalFrame>
      </Modal>

      <Modal
        visible={crmProfileModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => undefined}>
        <CrmModalFrame label="CRM coverage form"
          cardStyle={[styles.profileSetupCard, isCompact && styles.profileSetupCardCompact, isVeryCompact && styles.profileSetupCardVeryCompact]}>
            <Text style={styles.profileSetupTitle}>Set Your CRM Coverage</Text>
            <Text style={styles.profileSetupSubtitle}>
              Add your address, quadrant, and specialties so imported leads can be matched to the
              right CRM agent.
            </Text>

            <Text style={styles.modalSectionLabel}>Address</Text>
            <TextInput
              style={styles.profileAddressInput}
              value={crmProfileAddress}
              accessibilityLabel="CRM work area address"
              onChangeText={setCrmProfileAddress}
              placeholder="Enter your CRM work area address"
              placeholderTextColor="#94A3B8"
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              editable={!crmProfileSaving}
            />

            <Text style={styles.modalSectionLabel}>Quadrants</Text>
            <View style={styles.profileQuadrantGrid}>
              {CRM_QUADRANT_OPTIONS.map((option) => {
                const isSelected = crmProfileQuadrants.includes(option.value);
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.profileQuadrantChip,
                      isSelected && styles.profileQuadrantChipActive,
                    ]}
                    onPress={() => toggleCrmProfileQuadrant(option.value)}
                    accessibilityRole="checkbox"
                    accessibilityLabel={option.label}
                    accessibilityState={{ checked: isSelected, disabled: crmProfileSaving }}
                    disabled={crmProfileSaving}>
                    <Text
                      style={[
                        styles.profileQuadrantChipText,
                        isSelected && styles.profileQuadrantChipTextActive,
                      ]}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.modalSectionLabel}>Specialization</Text>
            <Text style={styles.profileFieldHint}>
              Tap to choose one. Long-press to select multiple specialties.
            </Text>
            <View style={styles.profileQuadrantGrid}>
              {CRM_SPECIALIZATION_OPTIONS.map((option) => {
                const isSelected = crmProfileSpecializations.includes(option.value);
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.profileQuadrantChip,
                      isSelected && styles.profileQuadrantChipActive,
                    ]}
                    onPress={() => handleCrmProfileSpecializationPress(option.value)}
                    accessibilityRole="button"
                    accessibilityLabel={option.label}
                    accessibilityHint="Tap to choose one specialty. Long press to select multiple specialties."
                    accessibilityState={{ selected: isSelected, disabled: crmProfileSaving }}
                    onLongPress={() => handleCrmProfileSpecializationLongPress(option.value)}
                    delayLongPress={220}
                    disabled={crmProfileSaving}>
                    <Text
                      style={[
                        styles.profileQuadrantChipText,
                        isSelected && styles.profileQuadrantChipTextActive,
                      ]}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity
              style={styles.profileSetupSaveBtn}
              accessibilityRole="button"
              accessibilityLabel="Save CRM coverage"
              accessibilityState={{ disabled: crmProfileSaving, busy: crmProfileSaving }}
              onPress={() => void saveCrmProfile()}
              disabled={crmProfileSaving}>
              {crmProfileSaving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.profileSetupSaveText}>Save CRM Coverage</Text>
              )}
            </TouchableOpacity>
        </CrmModalFrame>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 34,
  },
  scrollContentCompact: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 24,
  },
  heroCard: {
    borderRadius: 24,
    backgroundColor: '#0284C7',
    padding: 18,
    marginBottom: 18,
    overflow: 'hidden',
    shadowColor: '#023E73',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.45,
    shadowRadius: 20,
    elevation: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  heroCardCompact: {
    borderRadius: 18,
    padding: 14,
    marginBottom: 14,
  },
  heroGlow: {
    position: 'absolute',
    width: 180,
    height: 180,
    right: -50,
    top: -50,
    borderRadius: 90,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  heroDepth: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: -12,
    height: 28,
    borderRadius: 16,
    backgroundColor: 'rgba(2, 44, 84, 0.35)',
  },
  heroTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  heroTopRowCompact: {
    marginBottom: 10,
  },
  heroTopLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  heroTopLeftCompact: {
    marginRight: 8,
  },
  heroActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  menuBtn: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.22)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.18)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  topBtnCompact: {
    width: 34,
    height: 34,
    borderRadius: 10,
  },
  heroTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#fff',
  },
  heroTitleCompact: {
    fontSize: 20,
  },
  heroGreeting: {
    fontSize: 14,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.95)',
    marginTop: 2,
  },
  heroGreetingCompact: {
    fontSize: 12,
  },
  heroName: {
    fontWeight: '800',
    color: '#fff',
  },
  heroSubtitle: {
    color: 'rgba(255,255,255,0.78)',
    marginTop: 2,
    fontSize: 13,
  },
  heroSubtitleCompact: {
    fontSize: 12,
  },
  searchRow: {
    marginTop: 4,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  searchRowCompact: {
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  searchInput: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    marginLeft: 8,
  },
  searchInputCompact: {
    fontSize: 13,
  },
  filterGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingBottom: 2,
  },
  filterGridCompact: {
    gap: 6,
    paddingBottom: 0,
  },
  filterChip: {
    flexBasis: '31%',
    flexGrow: 1,
    minWidth: 0,
    minHeight: 38,
    paddingHorizontal: 7,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 1,
  },
  filterChipCompact: {
    flexBasis: '31.4%',
    minHeight: 34,
    paddingHorizontal: 5,
    paddingVertical: 6,
    borderRadius: 14,
  },
  filterChipVeryCompact: {
    flexBasis: '31.2%',
    minHeight: 32,
    paddingHorizontal: 4,
    paddingVertical: 5,
  },
  filterChipActive: {
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.28,
    shadowRadius: 6,
    elevation: 4,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
    includeFontPadding: false,
  },
  filterChipTextCompact: {
    fontSize: 11,
  },
  filterChipTextVeryCompact: {
    fontSize: 10,
  },
  filterChipTextActive: {
    fontWeight: '900',
  },
  dashboardFilterBanner: {
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.55)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dashboardFilterIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E0F2FE',
  },
  dashboardFilterTextWrap: {
    flex: 1,
  },
  dashboardFilterTitle: {
    color: '#0C4A6E',
    fontSize: 13,
    fontWeight: '800',
  },
  dashboardFilterDescription: {
    marginTop: 1,
    color: '#475569',
    fontSize: 11,
    fontWeight: '600',
  },
  dashboardFilterClear: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#BAE6FD',
  },
  heroIntegrationRow: {
    marginTop: 12,
    gap: 8,
  },
  heroIntegrationRowCompact: {
    marginTop: 10,
    gap: 6,
  },
  heroIntegrationRowVeryCompact: {
    marginTop: 8,
    gap: 4,
  },
  heroIntegrationCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    backgroundColor: 'rgba(255,255,255,0.12)',
    padding: 10,
    gap: 7,
  },
  heroIntegrationCardVeryCompact: {
    borderRadius: 10,
    padding: 8,
    gap: 5,
  },
  quickAddHeroCard: {
    backgroundColor: 'rgba(5,150,105,0.18)',
    borderColor: 'rgba(187,247,208,0.38)',
  },
  heroIntegrationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  heroIntegrationTitle: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '700',
  },
  heroIntegrationTitleVeryCompact: {
    fontSize: 11,
  },
  heroIntegrationText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 11,
  },
  heroIntegrationTextVeryCompact: {
    fontSize: 10,
  },
  heroIntegrationTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  heroIntegrationActions: {
    flexDirection: 'row',
    gap: 6,
  },
  heroIntegrationBtn: {
    flex: 1,
    borderRadius: 999,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroIntegrationCardCollapsed: {
    gap: 10,
  },
  heroIntegrationToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    backgroundColor: '#FDE68A',
    borderWidth: 1,
    borderColor: '#F59E0B',
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  heroIntegrationToggleText: {
    color: '#7C2D12',
    fontSize: 11,
    fontWeight: '800',
  },
  heroIntegrationBtnSuccess: {
    backgroundColor: '#059669',
  },
  heroIntegrationBtnDanger: {
    backgroundColor: '#B91C1C',
  },
  heroIntegrationBtnRefresh: {
    backgroundColor: '#FBBF24',
    borderWidth: 1,
    borderColor: '#F59E0B',
  },
  heroIntegrationBtnTransfer: {
    backgroundColor: '#7C3AED',
  },
  heroIntegrationBtnExpand: {
    backgroundColor: '#FED7AA',
    borderWidth: 1,
    borderColor: '#FB923C',
  },
  heroIntegrationBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#E0F2FE',
  },
  heroIntegrationBtnTextVeryCompact: {
    fontSize: 10,
  },
  heroIntegrationBtnTextDark: {
    color: '#7C2D12',
  },
  heroIntegrationBtnTextLight: {
    color: '#fff',
  },
  heroIntegrationBulkBtn: {
    borderRadius: 10,
    backgroundColor: '#16A34A',
    borderWidth: 1,
    borderColor: '#15803D',
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
  },
  heroIntegrationBulkBtnDisabled: {
    backgroundColor: '#BBF7D0',
    borderColor: '#86EFAC',
    opacity: 0.7,
  },
  heroIntegrationBulkBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
  },
  heroIntegrationBulkBtnTextVeryCompact: {
    fontSize: 10,
  },
  quickAddHeroTag: {
    borderRadius: 999,
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  quickAddHeroTagText: {
    color: '#047857',
    fontSize: 10,
    fontWeight: '900',
  },
  quickAddHeroBtn: {
    flexDirection: 'row',
    gap: 7,
    backgroundColor: '#16A34A',
    borderColor: '#15803D',
  },
  loadingWrap: {
    marginTop: 70,
    alignItems: 'center',
  },
  errorCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    backgroundColor: '#FEF2F2',
    padding: 12,
  },
  errorText: {
    color: '#B91C1C',
    fontSize: 13,
  },
  emptyCard: {
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
  },
  emptyTitle: {
    marginTop: 10,
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },
  emptySubtitle: {
    marginTop: 4,
    fontSize: 13,
    color: '#6B7280',
  },
  taskList: {
    gap: 12,
  },
  taskCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    backgroundColor: '#fff',
    padding: 14,
    shadowColor: '#1E3A5F',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 6,
  },
  taskCardCompact: {
    borderRadius: 15,
    padding: 11,
  },
  taskHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  taskHeaderRowCompact: {
    gap: 6,
  },
  taskHeaderInfo: {
    flex: 1,
  },
  taskClient: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  taskClientCompact: {
    fontSize: 15,
  },
  taskMeta: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  taskMetaCompact: {
    fontSize: 11,
  },
  statusBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  taskInfoRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  taskInfoRowCompact: {
    marginTop: 6,
    gap: 5,
  },
  taskInfoText: {
    fontSize: 12,
    color: '#4B5563',
    flex: 1,
  },
  taskInfoTextCompact: {
    fontSize: 11,
  },
  taskLinkText: {
    color: '#0369A1',
    textDecorationLine: 'underline',
  },
  socialChipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    flex: 1,
  },
  socialChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: 190,
    shadowColor: '#1D4ED8',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 1,
  },
  socialChipCompact: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: 170,
  },
  socialChipText: {
    fontSize: 11,
    color: '#0C4A6E',
    flexShrink: 1,
  },
  latestComment: {
    marginTop: 8,
    fontSize: 12,
    color: '#374151',
  },
  latestRecordingBtn: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#BAE6FD',
    borderRadius: 12,
    backgroundColor: '#F0F9FF',
    paddingVertical: 8,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  latestRecordingBtnText: {
    fontSize: 12,
    color: '#075985',
    fontWeight: '600',
  },
  timelineMediaDeleteBtn: {
    alignSelf: 'flex-start',
    borderRadius: 8,
    backgroundColor: '#DC2626',
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 96,
    alignItems: 'center',
  },
  timelineMediaDeleteBtnText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  taskActionRow: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 8,
  },
  taskActionRowSecondary: {
    marginTop: 8,
    flexDirection: 'row',
    gap: 8,
  },
  taskActionRowCompact: {
    marginTop: 10,
    gap: 6,
  },
  actionBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 5,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  actionBtnCompact: {
    borderRadius: 10,
    paddingVertical: 9,
    gap: 4,
  },
  callBtn: {
    backgroundColor: '#FBBF24',
    shadowColor: '#B45309',
  },
  emailBtn: {
    backgroundColor: '#2563EB',
    shadowColor: '#1D4ED8',
  },
  updateBtn: {
    backgroundColor: '#0284C7',
    shadowColor: '#0369A1',
  },
  calendarBtn: {
    backgroundColor: '#0EA5E9',
    shadowColor: '#0284C7',
  },
  transferBtn: {
    backgroundColor: '#7E22CE',
    shadowColor: '#7E22CE',
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  actionBtnTextCompact: {
    fontSize: 12,
  },
  taskCardVeryCompact: {
    borderRadius: 12,
    padding: 8,
  },
  statusBadgeVeryCompact: {
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  taskActionRowVeryCompact: {
    marginTop: 8,
    gap: 5,
  },
  actionBtnVeryCompact: {
    minHeight: 44,
    minWidth: 44,
    borderRadius: 8,
    paddingVertical: 8,
    gap: 0,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSafeArea: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalCard: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    flexShrink: 1,
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 16,
    paddingBottom: 16,
    maxHeight: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.2,
    shadowRadius: 20,
    elevation: 20,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
  },
  modalCardCompact: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  modalBodyScroll: {
    marginTop: 8,
    flexShrink: 1,
    flexGrow: 0,
  },
  modalBodyContent: {
    paddingBottom: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalTitle: {
    flexShrink: 1,
    fontSize: 18,
    fontWeight: '800',
    color: '#111827',
    letterSpacing: -0.3,
  },
  modalTitleVeryCompact: {
    fontSize: 16,
  },
  modalClientName: {
    color: '#0F172A',
    fontSize: 15,
    fontWeight: '700',
  },
  modalMetaText: {
    marginTop: 4,
    color: '#4B5563',
    fontSize: 12,
  },
  modalMetaLink: {
    marginTop: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
  },
  modalMetaLinkText: {
    color: '#0369A1',
    fontSize: 12,
    textDecorationLine: 'underline',
  },
  modalSectionLabel: {
    marginTop: 14,
    marginBottom: 8,
    fontSize: 12,
    fontWeight: '700',
    color: '#374151',
  },
  inlineCallList: {
    marginTop: 8,
    gap: 7,
  },
  inlineCallChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: '100%',
  },
  inlineCallChipText: {
    fontSize: 11,
    color: '#0C4A6E',
    fontWeight: '600',
    flexShrink: 1,
  },
  importDataWrap: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    backgroundColor: '#F8FAFC',
    overflow: 'hidden',
    marginLeft: 20,
    marginTop: 2,
    shadowColor: '#94A3B8',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 1,
  },
  importDataItem: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    gap: 3,
  },
  importDataLabel: {
    fontSize: 11,
    color: '#475569',
    fontWeight: '700',
  },
  importDataValue: {
    fontSize: 12,
    color: '#0F172A',
    lineHeight: 17,
  },
  commentHeaderRow: {
    marginTop: 14,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  commentVoiceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0EA5E9',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  commentVoiceBtnActive: {
    backgroundColor: '#DC2626',
  },
  commentVoiceBtnBusy: {
    backgroundColor: '#0369A1',
  },
  commentVoiceBtnText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  // Two equal columns, in workflow order (New Lead | Contacted, ... Won | Lost),
  // so the status buttons line up instead of wrapping one, two or three a row.
  statusGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statusGridVeryCompact: {
    gap: 5,
  },
  statusOptionVeryCompact: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  statusOption: {
    // Basis under half plus grow: exactly two per row, both the same width.
    flexBasis: '40%',
    flexGrow: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
    backgroundColor: '#fff',
  },
  statusOptionActive: {
    borderColor: '#0284C7',
    backgroundColor: '#E0F2FE',
    shadowColor: '#0284C7',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  statusOptionText: {
    fontSize: 11,
    color: '#4B5563',
    fontWeight: '600',
    textAlign: 'center',
  },
  statusOptionTextVeryCompact: {
    fontSize: 10,
  },
  statusOptionTextActive: {
    color: '#0C4A6E',
  },
  autoReminderCard: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#BAE6FD',
    backgroundColor: '#F0F9FF',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  autoReminderText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: '#0C4A6E',
    fontWeight: '600',
  },
  reminderDateTrigger: {
    marginTop: 2,
    borderWidth: 1,
    borderColor: '#BAE6FD',
    backgroundColor: '#F0F9FF',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  reminderDateTriggerDisabled: {
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
  },
  reminderDateTriggerText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: '#0C4A6E',
    fontWeight: '600',
  },
  reminderDateTriggerTextDisabled: {
    color: '#64748B',
  },
  reminderDateMetaRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  reminderDateMetaText: {
    flex: 1,
    fontSize: 11,
    color: '#475569',
  },
  reminderDateClearText: {
    fontSize: 11,
    color: '#0C4A6E',
    fontWeight: '700',
  },
  reminderDatePickerWrap: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    paddingTop: 2,
    paddingBottom: 8,
    paddingHorizontal: 6,
  },
  reminderDateDoneBtn: {
    alignSelf: 'flex-end',
    marginTop: 4,
    marginRight: 6,
    backgroundColor: '#0284C7',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  reminderDateDoneText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  commentInputVeryCompact: {
    minHeight: 72,
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  commentInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    minHeight: 92,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
    fontSize: 14,
    color: '#111827',
    backgroundColor: '#FAFBFC',
    shadowColor: '#94A3B8',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 1,
  },
  modalActionsRow: {
    marginTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  modalActionsRowVeryCompact: {
    gap: 5,
  },
  fileBtnVeryCompact: {
    paddingVertical: 7,
    borderRadius: 8,
    gap: 4,
    minWidth: '45%',
  },
  fileBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#BAE6FD',
    borderRadius: 10,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    backgroundColor: '#F0F9FF',
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 1,
  },
  fileBtnText: {
    fontSize: 12,
    color: '#0C4A6E',
    fontWeight: '600',
  },
  fileBtnTextVeryCompact: {
    fontSize: 10,
  },
  attachmentRow: {
    marginTop: 8,
    gap: 6,
  },
  timelineEmptyText: {
    marginTop: 4,
    fontSize: 12,
    color: '#6B7280',
  },
  timelineList: {
    marginTop: 8,
    gap: 8,
  },
  timelineCard: {
    borderWidth: 1,
    borderColor: '#D1FAE5',
    backgroundColor: '#ECFEFF',
    borderRadius: 14,
    padding: 10,
    gap: 6,
    shadowColor: '#0F766E',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
  timelineTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  timelineAuthor: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0C4A6E',
    flex: 1,
  },
  timelineDate: {
    fontSize: 11,
    color: '#6B7280',
  },
  timelineStatusText: {
    fontSize: 11,
    color: '#0F766E',
    fontWeight: '600',
  },
  timelineMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  timelineEditedBadge: {
    fontSize: 10,
    color: '#2563EB',
    fontWeight: '700',
    backgroundColor: '#DBEAFE',
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  timelineDeletedBadge: {
    fontSize: 10,
    color: '#B91C1C',
    fontWeight: '700',
    backgroundColor: '#FEE2E2',
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  timelineDeletedText: {
    fontSize: 12,
    color: '#B91C1C',
    fontStyle: 'italic',
  },
  timelineEditBox: {
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
    borderRadius: 10,
    padding: 8,
    gap: 8,
  },
  timelineEditInput: {
    borderWidth: 1,
    borderColor: '#BFDBFE',
    borderRadius: 8,
    backgroundColor: '#fff',
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 64,
    color: '#0F172A',
    textAlignVertical: 'top',
  },
  timelineEditStatusRow: {
    gap: 6,
  },
  timelineEditStatusChip: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 999,
    backgroundColor: '#fff',
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  timelineEditStatusChipActive: {
    borderColor: '#0284C7',
    backgroundColor: '#E0F2FE',
  },
  timelineEditStatusText: {
    fontSize: 11,
    color: '#475569',
    fontWeight: '600',
  },
  timelineEditStatusTextActive: {
    color: '#0C4A6E',
  },
  timelineComment: {
    fontSize: 13,
    color: '#1F2937',
    lineHeight: 18,
  },
  timelineActionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  timelineActionBtn: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 86,
  },
  timelineActionSecondary: {
    backgroundColor: '#E0F2FE',
    borderWidth: 1,
    borderColor: '#BAE6FD',
  },
  timelineActionSecondaryText: {
    color: '#0C4A6E',
    fontSize: 11,
    fontWeight: '700',
  },
  timelineActionDanger: {
    backgroundColor: '#DC2626',
  },
  timelineActionDangerText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  timelineCancelBtn: {
    backgroundColor: '#E5E7EB',
  },
  timelineCancelBtnText: {
    color: '#374151',
    fontSize: 11,
    fontWeight: '700',
  },
  timelineSaveBtn: {
    backgroundColor: '#0284C7',
  },
  timelineSaveBtnText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  timelineAttachmentWrap: {
    gap: 8,
  },
  timelineAttachmentItem: {
    gap: 6,
  },
  timelineAttachmentBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: '#BAE6FD',
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  timelineAttachmentImage: {
    width: '100%',
    maxWidth: 280,
    minWidth: 160,
    height: 140,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#BAE6FD',
    backgroundColor: '#E2E8F0',
  },
  timelineAttachmentText: {
    fontSize: 11,
    color: '#0C4A6E',
    fontWeight: '600',
  },
  timelineRecordingWrap: {
    gap: 6,
  },
  timelineRecordingBtn: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    borderRadius: 10,
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  timelineRecordingText: {
    fontSize: 12,
    color: '#075985',
    fontWeight: '600',
  },
  attachmentTag: {
    maxWidth: 190,
    borderRadius: 999,
    backgroundColor: '#E0F2FE',
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  attachmentTagText: {
    fontSize: 11,
    color: '#075985',
    maxWidth: 150,
  },
  attachmentRemoveBtn: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#0284C7',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalFooterRow: {
    marginTop: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  modalFooterRowVeryCompact: {
    marginTop: 12,
    gap: 8,
  },
  cancelBtn: {
    flex: 1,
    minHeight: 44,
    minWidth: 100,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  cancelBtnText: {
    color: '#374151',
    fontWeight: '700',
  },
  submitBtn: {
    flex: 1,
    minHeight: 44,
    minWidth: 100,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#0284C7',
    paddingVertical: 12,
    alignItems: 'center',
    shadowColor: '#0284C7',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    textAlign: 'center',
  },
  submitBtnText: {
    color: '#fff',
    fontWeight: '800',
    textAlign: 'center',
  },
  calendarSyncModalCardVeryCompact: {
    borderRadius: 14,
    padding: 10,
  },
  calendarSyncModalCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
    maxHeight: '86%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 20,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
  },
  calendarSyncHeaderTextWrap: {
    flex: 1,
    paddingRight: 8,
  },
  calendarSyncSummaryText: {
    marginTop: 2,
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '600',
  },
  calendarSyncSearchRow: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#FCD34D',
    backgroundColor: '#FFFBEB',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  calendarSyncSearchInput: {
    flex: 1,
    color: '#111827',
    fontSize: 14,
  },
  calendarSyncFilterRow: {
    marginTop: 10,
    gap: 8,
    paddingBottom: 2,
  },
  calendarSyncFilterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  calendarSyncFilterChipActive: {
    backgroundColor: '#FBBF24',
    borderColor: '#F59E0B',
  },
  calendarSyncFilterChipText: {
    color: '#4B5563',
    fontSize: 12,
    fontWeight: '700',
  },
  calendarSyncFilterChipTextActive: {
    color: '#7C2D12',
  },
  calendarSyncQuickActions: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 8,
  },
  calendarSyncQuickBtn: {
    minHeight: 44,
    justifyContent: 'center',
    flex: 1,
    borderRadius: 10,
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#86EFAC',
    paddingVertical: 8,
    alignItems: 'center',
  },
  calendarSyncQuickBtnClear: {
    backgroundColor: '#FFF7ED',
    borderColor: '#FDBA74',
  },
  calendarSyncQuickBtnText: {
    color: '#14532D',
    fontSize: 11,
    fontWeight: '800',
  },
  calendarSyncEmptyWrap: {
    paddingVertical: 30,
    alignItems: 'center',
    gap: 8,
  },
  calendarSyncTaskList: {
    marginTop: 12,
    maxHeight: 300,
  },
  calendarSyncTaskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
    padding: 12,
    marginBottom: 8,
  },
  calendarSyncTaskRowSelected: {
    borderColor: '#16A34A',
    backgroundColor: '#F0FDF4',
  },
  calendarSyncCheckbox: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: '#CBD5E1',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarSyncCheckboxSelected: {
    borderColor: '#16A34A',
    backgroundColor: '#16A34A',
  },
  calendarSyncTaskBody: {
    flex: 1,
    minWidth: 0,
  },
  calendarSyncTaskTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  calendarSyncTaskTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '800',
    color: '#111827',
  },
  calendarSyncTaskMeta: {
    marginTop: 2,
    fontSize: 12,
    color: '#6B7280',
  },
  calendarSyncStatusBadge: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  calendarSyncStatusBadgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  calendarSyncSubmitBtn: {
    backgroundColor: '#16A34A',
    shadowColor: '#15803D',
  },
  calendarSyncSubmitBtnDisabled: {
    backgroundColor: '#86EFAC',
    shadowOpacity: 0,
    elevation: 0,
  },
  centerModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 16,
  },
  centerModalOverlayVeryCompact: {
    padding: 8,
  },
  quickAddModal: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
    width: '100%',
    maxWidth: 460,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 20,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
  },
  quickAddModalCompact: {
    borderRadius: 14,
    padding: 10,
  },
  quickAddModalSubtitle: {
    marginTop: 2,
    fontSize: 12,
    color: '#059669',
    fontWeight: '800',
  },
  quickAddCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickAddInput: {
    minHeight: 46,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    paddingHorizontal: 13,
    marginTop: 10,
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '600',
    backgroundColor: '#F8FAFC',
  },
  quickAddFieldLabel: {
    marginTop: 10,
    marginBottom: 8,
    fontSize: 12,
    fontWeight: '900',
    color: '#475569',
    textTransform: 'uppercase',
  },
  quickAddChipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  quickAddSpecializationChip: {
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  quickAddSpecializationChipActive: {
    borderColor: '#0284C7',
    backgroundColor: '#E0F2FE',
  },
  quickAddSpecializationChipText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '800',
  },
  quickAddSpecializationChipTextActive: {
    color: '#075985',
  },
  quickAddDateButton: {
    minHeight: 46,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    paddingHorizontal: 13,
    backgroundColor: '#F8FAFC',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  quickAddDateButtonText: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '800',
  },
  quickAddNotesInput: {
    minHeight: 92,
    paddingTop: 12,
  },
  quickAddCreateBtn: {
    backgroundColor: '#16A34A',
    shadowColor: '#15803D',
  },
  quickAddDisabledBtn: {
    opacity: 0.65,
  },
  callModalCardVeryCompact: {
    borderRadius: 14,
    padding: 10,
  },
  callModalCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
    maxHeight: '78%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 20,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
  },
  callModalCardCompact: {
    borderRadius: 16,
    padding: 12,
  },
  callModalCardVeryCompactInner: {
    borderRadius: 12,
    padding: 10,
  },
  callOptionList: {
    marginTop: 12,
    gap: 8,
  },
  callOptionBtn: {
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#F8FCFF',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  callOptionBadge: {
    borderRadius: 999,
    backgroundColor: '#DBEAFE',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  callOptionBadgeText: {
    fontSize: 10,
    color: '#1D4ED8',
    fontWeight: '700',
  },
  callOptionValue: {
    flex: 1,
    fontSize: 13,
    color: '#0F172A',
    fontWeight: '600',
  },
  profileSetupCardVeryCompact: {
    borderRadius: 14,
    padding: 10,
  },
  profileSetupCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 20,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
  },
  profileSetupCardCompact: {
    borderRadius: 16,
    padding: 14,
  },
  profileSetupTitle: {
    fontSize: 18,
    color: '#111827',
    fontWeight: '800',
  },
  profileSetupSubtitle: {
    marginTop: 5,
    fontSize: 12,
    lineHeight: 18,
    color: '#475569',
  },
  profileAddressInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    minHeight: 88,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#111827',
    fontSize: 14,
    textAlignVertical: 'top',
    backgroundColor: '#F8FAFC',
  },
  profileQuadrantGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  profileFieldHint: {
    marginTop: -4,
    marginBottom: 8,
    color: '#64748B',
    fontSize: 11,
  },
  profileQuadrantChip: {
    minHeight: 44,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#fff',
  },
  profileQuadrantChipActive: {
    borderColor: '#0284C7',
    backgroundColor: '#E0F2FE',
  },
  profileQuadrantChipText: {
    color: '#334155',
    fontSize: 11,
    fontWeight: '700',
  },
  profileQuadrantChipTextActive: {
    color: '#0C4A6E',
  },
  profileSetupSaveBtn: {
    marginTop: 16,
    borderRadius: 12,
    backgroundColor: '#0284C7',
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0284C7',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  profileSetupSaveText: {
    color: '#fff',
    fontWeight: '800',
  },
  transferModalCardVeryCompact: {
    borderRadius: 14,
    padding: 10,
  },
  transferModalCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
    maxHeight: '84%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 20,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
  },
  transferModalCardCompact: {
    borderRadius: 16,
    padding: 12,
  },
  transferAgentList: {
    maxHeight: 180,
  },
  transferAgentItem: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    backgroundColor: '#F9FAFB',
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginBottom: 8,
  },
  transferAgentItemActive: {
    borderColor: '#0284C7',
    backgroundColor: '#E0F2FE',
  },
  transferAgentName: {
    color: '#0F172A',
    fontSize: 13,
    fontWeight: '700',
  },
  transferAgentNameActive: {
    color: '#0C4A6E',
  },
  transferAgentMeta: {
    marginTop: 2,
    fontSize: 11,
    color: '#6B7280',
  },
  transferAgentMetaActive: {
    color: '#0369A1',
  },
  transferNoteInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    minHeight: 80,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: '#111827',
    backgroundColor: '#F9FAFB',
    textAlignVertical: 'top',
  },
  transferSendBtn: {
    backgroundColor: '#7E22CE',
    shadowColor: '#7E22CE',
  },
  inboxList: {
    marginTop: 10,
  },
  inboxCard: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    backgroundColor: '#F8FAFC',
    padding: 10,
    marginBottom: 8,
    gap: 3,
  },
  inboxTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#111827',
  },
  inboxMeta: {
    fontSize: 11,
    color: '#6B7280',
  },
  inboxNote: {
    marginTop: 4,
    fontSize: 12,
    color: '#374151',
  },
  inboxActionRow: {
    marginTop: 8,
    flexDirection: 'row',
    gap: 8,
  },
  inboxActionBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inboxAcceptBtn: {
    backgroundColor: '#059669',
  },
  inboxRejectBtn: {
    backgroundColor: '#DC2626',
  },
  inboxActionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  inboxStatusTag: {
    marginTop: 8,
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#E2E8F0',
  },
  inboxStatusText: {
    color: '#334155',
    fontSize: 11,
    fontWeight: '700',
  },
});

const accStyles = StyleSheet.create({
  header: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 12,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    shadowColor: '#94A3B8',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  icon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  headerText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
  },
  body: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 8,
    borderLeftWidth: 2,
    borderLeftColor: '#E2E8F0',
    marginLeft: 20,
    marginTop: 2,
  },
});

const emailStyles = StyleSheet.create({
  fieldLabel: {
    marginTop: 12,
    marginBottom: 4,
    fontSize: 12,
    fontWeight: '700',
    color: '#374151',
  },
  fieldInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#111827',
    backgroundColor: '#F9FAFB',
  },
  bodyHeaderRow: {
    marginTop: 12,
    marginBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
  },
  toolRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  toolBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#0EA5E9',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  toolBtnVeryCompact: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    gap: 4,
  },
  toolBtnRecording: {
    backgroundColor: '#DC2626',
  },
  toolBtnBusy: {
    backgroundColor: '#0369A1',
  },
  toolBtnAI: {
    backgroundColor: '#7C3AED',
  },
  toolBtnText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  toolBtnTextVeryCompact: {
    fontSize: 10,
  },
  bodyInputVeryCompact: {
    minHeight: 90,
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  bodyInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    minHeight: 120,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#111827',
    backgroundColor: '#F9FAFB',
    textAlignVertical: 'top',
  },
  senderInfo: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  senderText: {
    fontSize: 11,
    color: '#6B7280',
    flex: 1,
  },
  sendBtn: {
    flexDirection: 'row',
    gap: 6,
    backgroundColor: '#7C3AED',
    textAlign: 'center',
  },
});

const chooserStyles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.25,
    shadowRadius: 28,
    elevation: 24,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
  },
  subtitle: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 2,
    marginBottom: 16,
  },
  optionList: {
    gap: 10,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: '#FAFBFC',
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  optionTextWrap: {
    flex: 1,
  },
  optionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
  },
  optionDesc: {
    fontSize: 11,
    color: '#9CA3AF',
    marginTop: 1,
  },
  cancelBtn: {
    marginTop: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#F9FAFB',
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelBtnText: {
    color: '#374151',
    fontWeight: '700',
    fontSize: 14,
  },
});

const htmlStyles = StyleSheet.create({
  toolBtnEdit: {
    backgroundColor: '#059669',
  },
  toolBtnPreview: {
    backgroundColor: '#6366F1',
  },
  htmlPreviewWrap: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    backgroundColor: '#FAFBFC',
    overflow: 'hidden',
  },
  htmlPreview: {
    minHeight: 160,
    maxHeight: 260,
    backgroundColor: 'transparent',
  },
  htmlPreviewEditHint: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    backgroundColor: '#F3F4F6',
  },
  htmlPreviewEditHintText: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '600',
  },
});

export default CrmTasksScreen;
