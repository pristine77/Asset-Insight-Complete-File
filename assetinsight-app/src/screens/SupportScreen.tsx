import { Feather } from '@expo/vector-icons';
import { ResizeMode, Video } from 'expo-av';
import * as Crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppTheme, type AppThemeColors } from '../context/ThemeContext';
import { ensurePhotoPickerAccess } from '../utils/photoPickerAccess';
import { collectSupportDiagnostics } from '../services/supportDiagnostics';
import {
  createSupportConversation,
  getSupportUploadConstraints,
  getSupportConversation,
  getSupportErrorMessage,
  listSupportConversations,
  listSupportMessages,
  markSupportConversationRead,
  sendSupportMessage,
  uploadSupportAttachment,
  type LocalSupportAttachment,
  type SupportAttachment,
  type SupportCategory,
  type SupportConversation,
  type SupportMessage,
  type SupportUploadConstraints,
} from '../services/supportService';
import {
  inferSupportMediaType,
  SUPPORT_ATTACHMENT_LIMIT,
  validateSupportMedia,
} from '../utils/supportMedia';
import {
  createSupportReplyClientMessageState,
  supportReplyDraftFingerprint,
  synchronizeSupportReplyClientMessageState,
} from '../utils/supportReplyIdentity';

type SupportScreenProps = {
  onOpenDrawer: () => void;
  onBack: () => void;
};

type ScreenMode = 'list' | 'new' | 'thread';
type Styles = ReturnType<typeof createStyles>;
type PendingMedia = LocalSupportAttachment & {
  localId: string;
  uploaded?: SupportAttachment;
  progress?: number;
};

const CATEGORY_OPTIONS: {
  value: SupportCategory;
  label: string;
  description: string;
  icon: keyof typeof Feather.glyphMap;
}[] = [
  {
    value: 'error',
    label: 'Report an error',
    description: 'Something is not working',
    icon: 'alert-triangle',
  },
  {
    value: 'feature',
    label: 'Request a feature',
    description: 'Suggest an improvement',
    icon: 'zap',
  },
  {
    value: 'question',
    label: 'Ask a question',
    description: 'Get help from our team',
    icon: 'help-circle',
  },
  { value: 'other', label: 'Other', description: 'Anything else', icon: 'message-circle' },
];

const STATUS_COPY: Record<SupportConversation['status'], string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_on_user: 'Waiting on you',
  resolved: 'Resolved',
  closed: 'Closed',
};

const CATEGORY_COPY: Record<SupportCategory, string> = {
  error: 'Error',
  feature: 'Feature',
  question: 'Question',
  other: 'Other',
};

const DEFAULT_UPLOAD_CONSTRAINTS: SupportUploadConstraints = {
  imageContentTypes: [],
  videoContentTypes: [],
  maxImageBytes: 20 * 1024 * 1024,
  maxVideoBytes: 250 * 1024 * 1024,
  maxAttachmentsPerMessage: SUPPORT_ATTACHMENT_LIMIT,
};

function statusColors(status: SupportConversation['status'], colors: AppThemeColors) {
  if (status === 'resolved') return { background: colors.successSoft, foreground: colors.success };
  if (status === 'closed') return { background: colors.surfaceMuted, foreground: colors.textMuted };
  if (status === 'waiting_on_user') {
    return { background: colors.warningSoft, foreground: colors.warning };
  }
  if (status === 'in_progress') return { background: colors.infoSoft, foreground: colors.info };
  return { background: colors.accentSoft, foreground: colors.accent };
}

function dateValue(value?: string): number {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function formatRelativeDate(value?: string): string {
  const time = dateValue(value);
  if (!time) return '';
  const elapsed = Date.now() - time;
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  const date = new Date(time);
  if (elapsed < 604_800_000) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatMessageTime(value?: string): string {
  const time = dateValue(value);
  if (!time) return '';
  return new Date(time).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function mergeMessages(current: SupportMessage[], incoming: SupportMessage[]): SupportMessage[] {
  const byKey = new Map<string, SupportMessage>();
  for (const message of [...current, ...incoming]) {
    const key = message.id || message.clientMessageId;
    if (key) byKey.set(key, message);
  }
  return [...byKey.values()].sort((a, b) => dateValue(a.createdAt) - dateValue(b.createdAt));
}

function Header({
  title,
  eyebrow,
  onMenu,
  onBack,
  trailing,
  styles,
  colors,
}: {
  title: string;
  eyebrow: string;
  onMenu?: () => void;
  onBack?: () => void;
  trailing?: React.ReactNode;
  styles: Styles;
  colors: AppThemeColors;
}) {
  return (
    <View style={styles.appBar}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={onBack ? 'Go back' : 'Open navigation'}
        onPress={onBack || onMenu}
        style={styles.appBarButton}
        activeOpacity={0.72}>
        <Feather name={onBack ? 'arrow-left' : 'menu'} size={20} color={colors.text} />
      </TouchableOpacity>
      <View style={styles.appBarCopy}>
        <Text style={styles.appBarEyebrow}>{eyebrow}</Text>
        <Text style={styles.appBarTitle} numberOfLines={1}>
          {title}
        </Text>
      </View>
      {trailing || <View style={styles.appBarButtonPlaceholder} />}
    </View>
  );
}

function StatusBadge({
  status,
  styles,
  colors,
}: {
  status: SupportConversation['status'];
  styles: Styles;
  colors: AppThemeColors;
}) {
  const palette = statusColors(status, colors);
  return (
    <View style={[styles.statusBadge, { backgroundColor: palette.background }]}>
      <View style={[styles.statusDot, { backgroundColor: palette.foreground }]} />
      <Text style={[styles.statusText, { color: palette.foreground }]}>{STATUS_COPY[status]}</Text>
    </View>
  );
}

function PendingMediaStrip({
  items,
  disabled,
  onRemove,
  styles,
  colors,
}: {
  items: PendingMedia[];
  disabled: boolean;
  onRemove: (id: string) => void;
  styles: Styles;
  colors: AppThemeColors;
}) {
  if (!items.length) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.pendingMediaRow}
      keyboardShouldPersistTaps="handled">
      {items.map((item) => (
        <View key={item.localId} style={styles.pendingMediaCard}>
          {item.kind === 'image' ? (
            <Image source={{ uri: item.uri }} style={styles.pendingMediaImage} />
          ) : (
            <View style={styles.pendingVideoPreview}>
              <Feather name="video" size={21} color={colors.accent} />
            </View>
          )}
          {typeof item.progress === 'number' && item.progress < 1 ? (
            <View style={styles.pendingProgressOverlay}>
              <Text style={styles.pendingProgressText}>{Math.round(item.progress * 100)}%</Text>
            </View>
          ) : null}
          {item.uploaded ? (
            <View style={styles.uploadedCheck}>
              <Feather name="check" size={10} color="#FFFFFF" />
            </View>
          ) : null}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Remove ${item.fileName}`}
            disabled={disabled}
            onPress={() => onRemove(item.localId)}
            style={styles.removeMediaButton}>
            <Feather name="x" size={12} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={styles.pendingMediaName} numberOfLines={1}>
            {item.fileName}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

function RemoteAttachmentView({
  attachment,
  onOpenImage,
  styles,
  colors,
}: {
  attachment: SupportAttachment;
  onOpenImage: (url: string) => void;
  styles: Styles;
  colors: AppThemeColors;
}) {
  if (!attachment.url) {
    return (
      <View style={styles.processingAttachment}>
        <ActivityIndicator size="small" color={colors.textMuted} />
        <Text style={styles.processingAttachmentText}>Processing {attachment.fileName}</Text>
      </View>
    );
  }
  if (attachment.kind === 'video') {
    return (
      <View style={styles.remoteVideoCard}>
        <Video
          source={{ uri: attachment.url }}
          style={styles.remoteVideo}
          resizeMode={ResizeMode.CONTAIN}
          useNativeControls
          shouldPlay={false}
        />
        <TouchableOpacity
          onPress={() => void Linking.openURL(attachment.url as string)}
          style={styles.openMediaRow}>
          <Feather name="external-link" size={13} color={colors.textSecondary} />
          <Text style={styles.openMediaText} numberOfLines={1}>
            {attachment.fileName}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }
  return (
    <TouchableOpacity
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open ${attachment.fileName}`}
      activeOpacity={0.88}
      onPress={() => onOpenImage(attachment.url as string)}>
      <Image source={{ uri: attachment.url }} style={styles.remoteImage} resizeMode="cover" />
    </TouchableOpacity>
  );
}

async function pickSupportMedia(
  existingCount: number,
  constraints: SupportUploadConstraints
): Promise<PendingMedia[]> {
  const limit = constraints.maxAttachmentsPerMessage;
  if (existingCount >= limit) {
    Alert.alert('Attachment limit', `You can attach up to ${limit} files.`);
    return [];
  }
  if (!(await ensurePhotoPickerAccess())) {
    Alert.alert(
      'Photos permission required',
      'Allow photo library access in system settings to attach screenshots or videos.'
    );
    return [];
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    selectionLimit: limit - existingCount,
    quality: 0.85,
  });
  if (result.canceled) return [];

  const accepted: PendingMedia[] = [];
  for (const [index, asset] of result.assets.entries()) {
    const fallbackName = `${asset.type === 'video' ? 'support-video' : 'support-image'}-${Date.now()}-${index + 1}`;
    const media = inferSupportMediaType({
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      assetType: asset.type,
    });
    if (!media) continue;
    const item: PendingMedia = {
      localId: Crypto.randomUUID(),
      uri: asset.uri,
      fileName: asset.fileName || fallbackName,
      contentType: media.contentType,
      kind: media.kind,
      size: asset.fileSize,
      width: asset.width,
      height: asset.height,
      durationMs: asset.duration ?? undefined,
    };
    const error = validateSupportMedia(item, constraints);
    if (error) {
      Alert.alert('File not attached', `${item.fileName}: ${error}`);
      continue;
    }
    accepted.push(item);
  }
  return accepted;
}

export default function SupportScreen({ onOpenDrawer, onBack }: SupportScreenProps) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const messageListRef = useRef<FlatList<SupportMessage>>(null);
  const shouldScrollToEndRef = useRef(false);

  const [mode, setMode] = useState<ScreenMode>('list');
  const [conversations, setConversations] = useState<SupportConversation[]>([]);
  const [conversationCursor, setConversationCursor] = useState<string>();
  const [selectedConversation, setSelectedConversation] = useState<SupportConversation | null>(
    null
  );
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [messageCursor, setMessageCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [screenError, setScreenError] = useState<string>();
  const [uploadConstraints, setUploadConstraints] = useState(DEFAULT_UPLOAD_CONSTRAINTS);

  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<SupportCategory>('error');
  const [description, setDescription] = useState('');
  const [affectedArea, setAffectedArea] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [newMedia, setNewMedia] = useState<PendingMedia[]>([]);
  const [creating, setCreating] = useState(false);

  const [reply, setReply] = useState('');
  const [replyMedia, setReplyMedia] = useState<PendingMedia[]>([]);
  const replyDraftFingerprint = supportReplyDraftFingerprint(reply, replyMedia);
  const [initialReplyClientMessageState] = useState(() =>
    createSupportReplyClientMessageState(replyDraftFingerprint, () => Crypto.randomUUID())
  );
  const replyClientMessageStateRef = useRef(initialReplyClientMessageState);
  const [sending, setSending] = useState(false);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string>();

  const getReplyClientMessageId = useCallback(() => {
    replyClientMessageStateRef.current = synchronizeSupportReplyClientMessageState(
      replyClientMessageStateRef.current,
      replyDraftFingerprint,
      () => Crypto.randomUUID()
    );
    return replyClientMessageStateRef.current.clientMessageId;
  }, [replyDraftFingerprint]);

  const resetReplyClientMessageId = useCallback((body = '', attachments: PendingMedia[] = []) => {
    replyClientMessageStateRef.current = createSupportReplyClientMessageState(
      supportReplyDraftFingerprint(body, attachments),
      () => Crypto.randomUUID()
    );
  }, []);

  const adoptReplyClientMessageId = useCallback(
    (clientMessageId: string, body: string, attachments: PendingMedia[]) => {
      replyClientMessageStateRef.current = {
        fingerprint: supportReplyDraftFingerprint(body, attachments),
        clientMessageId,
      };
    },
    []
  );

  useEffect(() => {
    getReplyClientMessageId();
  }, [getReplyClientMessageId]);

  const replaceConversation = useCallback((conversation: SupportConversation) => {
    setConversations((current) => {
      const next = current.filter((item) => item.id !== conversation.id);
      return [conversation, ...next].sort(
        (a, b) =>
          dateValue(b.lastMessageAt || b.updatedAt) - dateValue(a.lastMessageAt || a.updatedAt)
      );
    });
  }, []);

  const loadConversations = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setScreenError(undefined);
      const page = await listSupportConversations();
      setConversations(page.conversations);
      setConversationCursor(page.nextCursor);
    } catch (error) {
      setScreenError(getSupportErrorMessage(error, 'Support requests could not be loaded.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    void getSupportUploadConstraints()
      .then(setUploadConstraints)
      .catch(() => undefined);
  }, []);

  const refreshThread = useCallback(
    async (conversationId: string, silent = false) => {
      try {
        if (!silent) setLoading(true);
        setScreenError(undefined);
        const [conversation, page] = await Promise.all([
          getSupportConversation(conversationId),
          listSupportMessages(conversationId),
        ]);
        setSelectedConversation(conversation);
        replaceConversation({ ...conversation, unreadCount: 0 });
        setMessages((current) => (silent ? mergeMessages(current, page.messages) : page.messages));
        setMessageCursor(page.nextCursor);
        void markSupportConversationRead(conversationId).catch(() => undefined);
      } catch (error) {
        if (!silent) {
          setScreenError(
            getSupportErrorMessage(error, 'This support conversation could not be loaded.')
          );
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [replaceConversation]
  );

  useEffect(() => {
    if (mode !== 'thread' || !selectedConversation?.id) return;
    let active = AppState.currentState === 'active';
    const subscription = AppState.addEventListener('change', (state) => {
      active = state === 'active';
      if (active) void refreshThread(selectedConversation.id, true);
    });
    const timer = setInterval(() => {
      if (active) void refreshThread(selectedConversation.id, true);
    }, 12_000);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [mode, refreshThread, selectedConversation?.id]);

  const openConversation = useCallback(
    (conversation: SupportConversation) => {
      setSelectedConversation(conversation);
      setMessages([]);
      setMessageCursor(undefined);
      setReply('');
      setReplyMedia([]);
      resetReplyClientMessageId();
      shouldScrollToEndRef.current = true;
      setMode('thread');
      void refreshThread(conversation.id);
    },
    [refreshThread, resetReplyClientMessageId]
  );

  const loadMoreConversations = async () => {
    if (!conversationCursor || loadingMore) return;
    try {
      setLoadingMore(true);
      const page = await listSupportConversations({ cursor: conversationCursor });
      setConversations((current) => {
        const ids = new Set(current.map((item) => item.id));
        return [...current, ...page.conversations.filter((item) => !ids.has(item.id))];
      });
      setConversationCursor(page.nextCursor);
    } catch (error) {
      Alert.alert('Could not load more', getSupportErrorMessage(error, 'Please try again.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const loadOlderMessages = async () => {
    if (!selectedConversation || !messageCursor || loadingMore) return;
    try {
      setLoadingMore(true);
      const page = await listSupportMessages(selectedConversation.id, { cursor: messageCursor });
      setMessages((current) => mergeMessages(page.messages, current));
      setMessageCursor(page.nextCursor);
    } catch (error) {
      Alert.alert(
        'Could not load earlier messages',
        getSupportErrorMessage(error, 'Please try again.')
      );
    } finally {
      setLoadingMore(false);
    }
  };

  const addMedia = async (target: 'new' | 'reply') => {
    const existing = target === 'new' ? newMedia : replyMedia;
    try {
      const picked = await pickSupportMedia(existing.length, uploadConstraints);
      if (!picked.length) return;
      const update = target === 'new' ? setNewMedia : setReplyMedia;
      update((current) =>
        [...current, ...picked].slice(0, uploadConstraints.maxAttachmentsPerMessage)
      );
    } catch (error) {
      Alert.alert(
        'Media unavailable',
        getSupportErrorMessage(error, 'The media picker could not open.')
      );
    }
  };

  const uploadMedia = async (
    conversationId: string,
    source: PendingMedia[],
    update: React.Dispatch<React.SetStateAction<PendingMedia[]>>
  ): Promise<{ items: PendingMedia[]; errors: string[] }> => {
    let current = source.map((item) => ({ ...item }));
    const errors: string[] = [];
    for (let index = 0; index < current.length; index += 1) {
      const item = current[index];
      if (item.uploaded) continue;
      try {
        const uploaded = await uploadSupportAttachment({
          conversationId,
          file: item,
          onProgress: (progress) => {
            current = current.map((entry) =>
              entry.localId === item.localId ? { ...entry, progress } : entry
            );
            update(current);
          },
        });
        current = current.map((entry) =>
          entry.localId === item.localId ? { ...entry, uploaded, progress: 1 } : entry
        );
        update(current);
      } catch (error) {
        errors.push(`${item.fileName}: ${getSupportErrorMessage(error, 'upload failed')}`);
      }
    }
    return { items: current, errors };
  };

  const resetNewRequest = () => {
    setSubject('');
    setCategory('error');
    setDescription('');
    setAffectedArea('');
    setErrorCode('');
    setIncludeDiagnostics(true);
    setNewMedia([]);
  };

  const createConversation = async () => {
    if (subject.trim().length < 4) {
      Alert.alert(
        'Subject required',
        'Add a short subject so the support team can identify the request.'
      );
      return;
    }
    if (description.trim().length < 10) {
      Alert.alert(
        'More detail needed',
        'Describe what happened or what you need in at least 10 characters.'
      );
      return;
    }
    let createdConversation: SupportConversation | null = null;
    let mediaAfterUpload = newMedia;
    let mediaMessageId: string | undefined;
    try {
      setCreating(true);
      const diagnostics = includeDiagnostics
        ? collectSupportDiagnostics({
            route: affectedArea.trim() || 'mobile/support/new',
            errorCode: category === 'error' ? errorCode : undefined,
            errorMessage: category === 'error' ? description : undefined,
          })
        : undefined;
      const conversation = await createSupportConversation({
        subject: subject.trim(),
        category,
        message: description.trim(),
        diagnostics,
      });
      createdConversation = conversation;
      replaceConversation(conversation);
      setSelectedConversation(conversation);
      shouldScrollToEndRef.current = true;
      setMode('thread');

      if (newMedia.length) {
        const result = await uploadMedia(conversation.id, newMedia, setNewMedia);
        mediaAfterUpload = result.items;
        if (result.errors.length) {
          setReplyMedia(result.items);
          Alert.alert(
            'Request created; media needs attention',
            `Your message is safe. Retry the remaining media from the conversation.\n\n${result.errors.join('\n')}`
          );
        } else {
          const attachmentIds = result.items
            .map((item) => item.uploaded?.id)
            .filter((id): id is string => Boolean(id));
          if (attachmentIds.length) {
            mediaMessageId = Crypto.randomUUID();
            await sendSupportMessage(conversation.id, {
              body: '',
              attachmentIds,
              clientMessageId: mediaMessageId,
            });
          }
        }
      }
      resetNewRequest();
      await refreshThread(conversation.id);
    } catch (error) {
      if (createdConversation) {
        setReplyMedia(mediaAfterUpload);
        if (mediaMessageId) adoptReplyClientMessageId(mediaMessageId, '', mediaAfterUpload);
        resetNewRequest();
        Alert.alert(
          'Request created',
          `Your description is safe, but the media could not be added yet. Retry it in the conversation.\n\n${getSupportErrorMessage(error, 'Please try again.')}`
        );
        await refreshThread(createdConversation.id);
      } else {
        Alert.alert('Request not sent', getSupportErrorMessage(error, 'Please try again.'));
      }
    } finally {
      setCreating(false);
    }
  };

  const sendReply = async () => {
    if (!selectedConversation || sending) return;
    if (!reply.trim() && !replyMedia.length) return;
    try {
      setSending(true);
      const uploadResult = await uploadMedia(selectedConversation.id, replyMedia, setReplyMedia);
      if (uploadResult.errors.length) {
        Alert.alert(
          'Some media did not upload',
          `Nothing was sent yet. Check your connection and retry.\n\n${uploadResult.errors.join('\n')}`
        );
        return;
      }
      const attachmentIds = uploadResult.items
        .map((item) => item.uploaded?.id)
        .filter((id): id is string => Boolean(id));
      const sent = await sendSupportMessage(selectedConversation.id, {
        body: reply.trim(),
        attachmentIds,
        clientMessageId: getReplyClientMessageId(),
      });
      setMessages((current) => mergeMessages(current, [sent]));
      setReply('');
      setReplyMedia([]);
      resetReplyClientMessageId();
      void markSupportConversationRead(selectedConversation.id).catch(() => undefined);
      setTimeout(() => messageListRef.current?.scrollToEnd({ animated: true }), 80);
      void refreshThread(selectedConversation.id, true);
    } catch (error) {
      Alert.alert('Message not sent', getSupportErrorMessage(error, 'Please try again.'));
    } finally {
      setSending(false);
    }
  };

  const renderConversation = ({ item }: { item: SupportConversation }) => (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`Open support request ${item.subject}`}
      onPress={() => openConversation(item)}
      style={styles.conversationCard}
      activeOpacity={0.78}>
      <View style={styles.conversationTopRow}>
        <View style={styles.categoryIcon}>
          <Feather
            name={
              CATEGORY_OPTIONS.find((option) => option.value === item.category)?.icon ||
              'message-circle'
            }
            size={16}
            color={colors.accent}
          />
        </View>
        <View style={styles.conversationHeading}>
          <Text style={styles.conversationSubject} numberOfLines={1}>
            {item.subject}
          </Text>
          <Text style={styles.conversationMeta}>
            {item.reference ? `${item.reference} · ` : ''}
            {CATEGORY_COPY[item.category]}
          </Text>
        </View>
        <Text style={styles.conversationTime}>
          {formatRelativeDate(item.lastMessageAt || item.updatedAt)}
        </Text>
      </View>
      {item.lastMessage ? (
        <Text style={styles.conversationPreview} numberOfLines={2}>
          {item.lastMessage}
        </Text>
      ) : null}
      <View style={styles.conversationFooter}>
        <StatusBadge status={item.status} styles={styles} colors={colors} />
        {item.unreadCount > 0 ? (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadBadgeText}>{Math.min(item.unreadCount, 99)}</Text>
          </View>
        ) : (
          <Feather name="chevron-right" size={17} color={colors.textMuted} />
        )}
      </View>
    </TouchableOpacity>
  );

  const renderMessage = ({ item }: { item: SupportMessage }) => {
    if (item.senderType === 'system') {
      return (
        <View style={styles.systemMessage}>
          <Feather name="activity" size={13} color={colors.textMuted} />
          <Text style={styles.systemMessageText}>{item.body}</Text>
        </View>
      );
    }
    const own = item.senderType === 'user';
    return (
      <View style={[styles.messageRow, own && styles.messageRowOwn]}>
        {!own ? (
          <View style={styles.agentAvatar}>
            <Feather name="headphones" size={14} color="#FFFFFF" />
          </View>
        ) : null}
        <View style={[styles.messageGroup, own && styles.messageGroupOwn]}>
          {!own ? (
            <Text style={styles.senderName}>{item.senderName || 'ClearValue Support'}</Text>
          ) : null}
          <View style={[styles.messageBubble, own ? styles.ownBubble : styles.agentBubble]}>
            {item.body ? (
              <Text style={[styles.messageBody, own && styles.ownMessageBody]}>{item.body}</Text>
            ) : null}
            {item.attachments.map((attachment) => (
              <RemoteAttachmentView
                key={attachment.id}
                attachment={attachment}
                onOpenImage={setImagePreviewUrl}
                styles={styles}
                colors={colors}
              />
            ))}
          </View>
          <Text style={[styles.messageTime, own && styles.messageTimeOwn]}>
            {formatMessageTime(item.createdAt)}
          </Text>
        </View>
      </View>
    );
  };

  if (mode === 'new') {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Header
            title="New support request"
            eyebrow="SUPPORT"
            onBack={() => setMode('list')}
            styles={styles}
            colors={colors}
          />
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.formContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <View style={styles.formIntro}>
              <View style={styles.formIntroIcon}>
                <Feather name="message-square" size={22} color={colors.accent} />
              </View>
              <View style={styles.flex}>
                <Text style={styles.formIntroTitle}>How can we help?</Text>
                <Text style={styles.formIntroText}>
                  Your request becomes a private chat with our developer team.
                </Text>
              </View>
            </View>

            <Text style={styles.fieldLabel}>Request type</Text>
            <View style={styles.categoryGrid}>
              {CATEGORY_OPTIONS.map((option) => {
                const active = category === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    onPress={() => {
                      setCategory(option.value);
                      setIncludeDiagnostics(option.value === 'error');
                    }}
                    style={[styles.categoryOption, active && styles.categoryOptionActive]}
                    activeOpacity={0.75}>
                    <View
                      style={[
                        styles.categoryOptionIcon,
                        active && styles.categoryOptionIconActive,
                      ]}>
                      <Feather
                        name={option.icon}
                        size={17}
                        color={active ? '#FFFFFF' : colors.textSecondary}
                      />
                    </View>
                    <View style={styles.flex}>
                      <Text
                        style={[styles.categoryOptionTitle, active && { color: colors.accent }]}>
                        {option.label}
                      </Text>
                      <Text style={styles.categoryOptionDescription}>{option.description}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.fieldLabel}>Subject</Text>
            <TextInput
              value={subject}
              onChangeText={setSubject}
              maxLength={160}
              placeholder="A short summary"
              placeholderTextColor={colors.textMuted}
              style={styles.textInput}
              returnKeyType="next"
            />

            <Text style={styles.fieldLabel}>What happened or what do you need?</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              maxLength={10_000}
              multiline
              textAlignVertical="top"
              placeholder={
                category === 'error'
                  ? 'Tell us what you expected, what happened, and how to reproduce it.'
                  : 'Share enough detail for the team to understand your request.'
              }
              placeholderTextColor={colors.textMuted}
              style={[styles.textInput, styles.largeTextInput]}
            />

            {category === 'error' ? (
              <View style={styles.diagnosticsCard}>
                <View style={styles.diagnosticsHeading}>
                  <View style={styles.diagnosticsIcon}>
                    <Feather name="shield" size={16} color={colors.info} />
                  </View>
                  <View style={styles.flex}>
                    <Text style={styles.diagnosticsTitle}>Safe diagnostics</Text>
                    <Text style={styles.diagnosticsDescription}>
                      App version, device model, OS and screen size only. No location, files,
                      passwords or tokens.
                    </Text>
                  </View>
                  <Switch
                    value={includeDiagnostics}
                    onValueChange={setIncludeDiagnostics}
                    trackColor={{ false: colors.borderStrong, true: colors.info }}
                    thumbColor="#FFFFFF"
                  />
                </View>
                <Text style={styles.smallFieldLabel}>Where did it happen? (optional)</Text>
                <TextInput
                  value={affectedArea}
                  onChangeText={setAffectedArea}
                  maxLength={240}
                  placeholder="Example: Asset form, photo upload"
                  placeholderTextColor={colors.textMuted}
                  style={styles.compactTextInput}
                />
                <Text style={styles.smallFieldLabel}>Error code (optional)</Text>
                <TextInput
                  value={errorCode}
                  onChangeText={setErrorCode}
                  maxLength={120}
                  autoCapitalize="characters"
                  placeholder="Example: UPLOAD_FAILED"
                  placeholderTextColor={colors.textMuted}
                  style={styles.compactTextInput}
                />
              </View>
            ) : null}

            <View style={styles.attachmentHeading}>
              <View>
                <Text style={styles.fieldLabelNoMargin}>Screenshots or videos</Text>
                <Text style={styles.fieldHint}>
                  Up to {uploadConstraints.maxAttachmentsPerMessage} files · images{' '}
                  {Math.round(uploadConstraints.maxImageBytes / (1024 * 1024))} MB · videos{' '}
                  {Math.round(uploadConstraints.maxVideoBytes / (1024 * 1024))} MB
                </Text>
              </View>
              <TouchableOpacity
                disabled={creating || newMedia.length >= uploadConstraints.maxAttachmentsPerMessage}
                onPress={() => void addMedia('new')}
                style={styles.attachButton}
                activeOpacity={0.72}>
                <Feather name="paperclip" size={15} color={colors.accent} />
                <Text style={styles.attachButtonText}>Attach</Text>
              </TouchableOpacity>
            </View>
            <PendingMediaStrip
              items={newMedia}
              disabled={creating}
              onRemove={(id) =>
                setNewMedia((current) => current.filter((item) => item.localId !== id))
              }
              styles={styles}
              colors={colors}
            />

            <TouchableOpacity
              disabled={creating}
              onPress={() => void createConversation()}
              style={[styles.primaryButton, creating && styles.buttonDisabled]}
              activeOpacity={0.8}>
              {creating ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Feather name="send" size={17} color="#FFFFFF" />
              )}
              <Text style={styles.primaryButtonText}>
                {creating ? 'Creating request…' : 'Start support chat'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (mode === 'thread' && selectedConversation) {
    const completed =
      selectedConversation.status === 'closed' || selectedConversation.status === 'resolved';
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}>
          <Header
            title={selectedConversation.subject}
            eyebrow={selectedConversation.reference || 'SUPPORT CHAT'}
            onBack={() => {
              setMode('list');
              setReply('');
              setReplyMedia([]);
              resetReplyClientMessageId();
              void loadConversations(true);
            }}
            trailing={
              <StatusBadge status={selectedConversation.status} styles={styles} colors={colors} />
            }
            styles={styles}
            colors={colors}
          />
          {loading && !messages.length ? (
            <View style={styles.centerState}>
              <ActivityIndicator size="large" color={colors.accent} />
              <Text style={styles.centerStateText}>Loading conversation…</Text>
            </View>
          ) : (
            <FlatList
              ref={messageListRef}
              data={messages}
              keyExtractor={(item) =>
                item.id || item.clientMessageId || `${item.createdAt}-${item.body}`
              }
              renderItem={renderMessage}
              style={styles.flex}
              contentContainerStyle={styles.messageList}
              keyboardShouldPersistTaps="handled"
              onContentSizeChange={() => {
                if (shouldScrollToEndRef.current) {
                  shouldScrollToEndRef.current = false;
                  messageListRef.current?.scrollToEnd({ animated: false });
                }
              }}
              ListHeaderComponent={
                <>
                  {messageCursor ? (
                    <TouchableOpacity
                      disabled={loadingMore}
                      onPress={() => void loadOlderMessages()}
                      style={styles.loadEarlierButton}>
                      {loadingMore ? (
                        <ActivityIndicator size="small" color={colors.accent} />
                      ) : (
                        <Feather name="clock" size={14} color={colors.accent} />
                      )}
                      <Text style={styles.loadEarlierText}>Load earlier messages</Text>
                    </TouchableOpacity>
                  ) : null}
                  <View style={styles.threadContext}>
                    <Text style={styles.threadContextText}>
                      {CATEGORY_COPY[selectedConversation.category]} request · Created{' '}
                      {formatMessageTime(selectedConversation.createdAt)}
                    </Text>
                  </View>
                </>
              }
              ListEmptyComponent={
                screenError ? (
                  <View style={styles.inlineError}>
                    <Feather name="alert-circle" size={20} color={colors.danger} />
                    <Text style={styles.inlineErrorText}>{screenError}</Text>
                    <TouchableOpacity onPress={() => void refreshThread(selectedConversation.id)}>
                      <Text style={styles.retryText}>Retry</Text>
                    </TouchableOpacity>
                  </View>
                ) : null
              }
            />
          )}

          {completed ? (
            <View style={styles.closedComposer}>
              <Feather name="refresh-cw" size={16} color={colors.textMuted} />
              <Text style={styles.closedComposerText}>
                Replying will reopen this request for the support team.
              </Text>
            </View>
          ) : null}
          <View style={styles.composerContainer}>
            <PendingMediaStrip
              items={replyMedia}
              disabled={sending}
              onRemove={(id) =>
                setReplyMedia((current) => current.filter((item) => item.localId !== id))
              }
              styles={styles}
              colors={colors}
            />
            <View style={styles.composerRow}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Attach image or video"
                disabled={
                  sending || replyMedia.length >= uploadConstraints.maxAttachmentsPerMessage
                }
                onPress={() => void addMedia('reply')}
                style={styles.composerAttachButton}>
                <Feather name="paperclip" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
              <TextInput
                value={reply}
                onChangeText={setReply}
                maxLength={10_000}
                multiline
                placeholder="Write a reply…"
                placeholderTextColor={colors.textMuted}
                style={styles.composerInput}
              />
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Send reply"
                disabled={sending || (!reply.trim() && !replyMedia.length)}
                onPress={() => void sendReply()}
                style={[
                  styles.sendButton,
                  (sending || (!reply.trim() && !replyMedia.length)) && styles.sendButtonDisabled,
                ]}>
                {sending ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Feather name="arrow-up" size={20} color="#FFFFFF" />
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>

        <Modal
          visible={Boolean(imagePreviewUrl)}
          transparent
          animationType="fade"
          onRequestClose={() => setImagePreviewUrl(undefined)}>
          <View style={styles.imagePreviewModal}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Close image"
              onPress={() => setImagePreviewUrl(undefined)}
              style={styles.imagePreviewClose}>
              <Feather name="x" size={24} color="#FFFFFF" />
            </TouchableOpacity>
            {imagePreviewUrl ? (
              <Image
                source={{ uri: imagePreviewUrl }}
                style={styles.imagePreview}
                resizeMode="contain"
              />
            ) : null}
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Header
        title="Help & support"
        eyebrow="CUSTOMER CARE"
        onMenu={onOpenDrawer}
        trailing={
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Return to dashboard"
            onPress={onBack}
            style={styles.appBarButton}>
            <Feather name="arrow-left" size={19} color={colors.text} />
          </TouchableOpacity>
        }
        styles={styles}
        colors={colors}
      />
      <FlatList
        data={conversations}
        keyExtractor={(item) => item.id}
        renderItem={renderConversation}
        style={styles.flex}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void loadConversations(true)}
            tintColor={colors.accent}
            colors={[colors.accent]}
          />
        }
        ListHeaderComponent={
          <View style={styles.supportHero}>
            <View style={styles.heroIcon}>
              <Feather name="headphones" size={24} color="#FFFFFF" />
            </View>
            <View style={styles.heroCopy}>
              <Text style={styles.heroEyebrow}>DIRECT DEVELOPER SUPPORT</Text>
              <Text style={styles.heroTitle}>Get help without leaving the app</Text>
              <Text style={styles.heroText}>
                Report errors with screenshots or video, request features, and follow every update
                as a conversation.
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setMode('new')}
              style={styles.newRequestButton}
              activeOpacity={0.82}>
              <Feather name="plus" size={17} color={colors.accent} />
              <Text style={styles.newRequestButtonText}>New request</Text>
            </TouchableOpacity>
            <View style={styles.listHeadingRow}>
              <Text style={styles.listHeading}>Your requests</Text>
              <Text style={styles.listCount}>{conversations.length}</Text>
            </View>
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <View style={styles.centerState}>
              <ActivityIndicator size="large" color={colors.accent} />
              <Text style={styles.centerStateText}>Loading support requests…</Text>
            </View>
          ) : screenError ? (
            <View style={styles.emptyState}>
              <View style={[styles.emptyStateIcon, { backgroundColor: colors.dangerSoft }]}>
                <Feather name="wifi-off" size={24} color={colors.danger} />
              </View>
              <Text style={styles.emptyStateTitle}>Could not load support</Text>
              <Text style={styles.emptyStateText}>{screenError}</Text>
              <TouchableOpacity
                onPress={() => void loadConversations()}
                style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <View style={styles.emptyStateIcon}>
                <Feather name="message-square" size={25} color={colors.accent} />
              </View>
              <Text style={styles.emptyStateTitle}>No support requests yet</Text>
              <Text style={styles.emptyStateText}>
                When you need help, start a private chat with the developer team.
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          conversationCursor ? (
            <TouchableOpacity
              disabled={loadingMore}
              onPress={() => void loadMoreConversations()}
              style={styles.loadMoreButton}>
              {loadingMore ? <ActivityIndicator size="small" color={colors.accent} /> : null}
              <Text style={styles.loadMoreText}>Load more requests</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.listFooterSpace} />
          )
        }
      />
    </SafeAreaView>
  );
}

const createStyles = (colors: AppThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    container: { flex: 1, backgroundColor: colors.background },
    appBar: {
      minHeight: 66,
      paddingHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.surface,
    },
    appBarButton: {
      width: 38,
      height: 38,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMuted,
      borderWidth: 1,
      borderColor: colors.border,
    },
    appBarButtonPlaceholder: { width: 38, height: 38 },
    appBarCopy: { flex: 1, minWidth: 0 },
    appBarEyebrow: { color: colors.accent, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
    appBarTitle: { color: colors.text, fontSize: 17, fontWeight: '900', marginTop: 2 },
    listContent: { padding: 14, paddingBottom: 28, flexGrow: 1 },
    supportHero: {
      padding: 18,
      borderRadius: 16,
      backgroundColor: colors.graphite,
      marginBottom: 12,
      overflow: 'hidden',
    },
    heroIcon: {
      width: 46,
      height: 46,
      borderRadius: 13,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
      marginBottom: 15,
    },
    heroCopy: { maxWidth: 520 },
    heroEyebrow: { color: '#FDA4AF', fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
    heroTitle: { color: '#FFFFFF', fontSize: 21, lineHeight: 27, fontWeight: '900', marginTop: 5 },
    heroText: { color: '#C8D0DC', fontSize: 12.5, lineHeight: 19, marginTop: 7 },
    newRequestButton: {
      alignSelf: 'flex-start',
      height: 40,
      borderRadius: 9,
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      backgroundColor: '#FFFFFF',
      marginTop: 16,
    },
    newRequestButtonText: { color: colors.accent, fontSize: 12, fontWeight: '900' },
    listHeadingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      marginTop: 24,
      paddingTop: 16,
      borderTopWidth: 1,
      borderTopColor: '#303640',
    },
    listHeading: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
    listCount: {
      minWidth: 21,
      height: 21,
      borderRadius: 11,
      textAlign: 'center',
      textAlignVertical: 'center',
      backgroundColor: '#303640',
      color: '#D7DEE8',
      fontSize: 10,
      fontWeight: '900',
    },
    conversationCard: {
      padding: 14,
      borderRadius: 13,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      marginTop: 8,
    },
    conversationTopRow: { flexDirection: 'row', alignItems: 'center' },
    categoryIcon: {
      width: 36,
      height: 36,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accentSoft,
      marginRight: 10,
    },
    conversationHeading: { flex: 1, minWidth: 0 },
    conversationSubject: { color: colors.text, fontSize: 13.5, fontWeight: '900' },
    conversationMeta: { color: colors.textMuted, fontSize: 9.5, fontWeight: '700', marginTop: 3 },
    conversationTime: { color: colors.textMuted, fontSize: 9.5, marginLeft: 8 },
    conversationPreview: {
      color: colors.textSecondary,
      fontSize: 11.5,
      lineHeight: 17,
      marginTop: 11,
    },
    conversationFooter: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 12,
    },
    statusBadge: {
      height: 25,
      borderRadius: 13,
      paddingHorizontal: 9,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
    },
    statusDot: { width: 5, height: 5, borderRadius: 3 },
    statusText: { fontSize: 9, fontWeight: '900' },
    unreadBadge: {
      minWidth: 23,
      height: 23,
      borderRadius: 12,
      paddingHorizontal: 6,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
    },
    unreadBadgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
    centerState: { minHeight: 190, alignItems: 'center', justifyContent: 'center', gap: 11 },
    centerStateText: { color: colors.textMuted, fontSize: 12 },
    emptyState: { alignItems: 'center', paddingHorizontal: 28, paddingVertical: 42 },
    emptyStateIcon: {
      width: 56,
      height: 56,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accentSoft,
    },
    emptyStateTitle: { color: colors.text, fontSize: 16, fontWeight: '900', marginTop: 15 },
    emptyStateText: {
      color: colors.textMuted,
      fontSize: 12,
      lineHeight: 18,
      textAlign: 'center',
      marginTop: 6,
    },
    secondaryButton: {
      marginTop: 16,
      height: 38,
      borderRadius: 9,
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMuted,
      borderWidth: 1,
      borderColor: colors.border,
    },
    secondaryButtonText: { color: colors.text, fontSize: 11.5, fontWeight: '900' },
    loadMoreButton: {
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 8,
    },
    loadMoreText: { color: colors.accent, fontSize: 11.5, fontWeight: '900' },
    listFooterSpace: { height: 14 },
    formContent: { padding: 16, paddingBottom: 34 },
    formIntro: {
      padding: 15,
      borderRadius: 13,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      flexDirection: 'row',
      gap: 12,
      alignItems: 'center',
      marginBottom: 18,
    },
    formIntroIcon: {
      width: 44,
      height: 44,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accentSoft,
    },
    formIntroTitle: { color: colors.text, fontSize: 14, fontWeight: '900' },
    formIntroText: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginTop: 3 },
    fieldLabel: {
      color: colors.textSecondary,
      fontSize: 10.5,
      fontWeight: '900',
      marginTop: 13,
      marginBottom: 7,
    },
    fieldLabelNoMargin: { color: colors.textSecondary, fontSize: 10.5, fontWeight: '900' },
    fieldHint: { color: colors.textMuted, fontSize: 9.5, marginTop: 3 },
    categoryGrid: { gap: 7 },
    categoryOption: {
      minHeight: 61,
      padding: 10,
      borderRadius: 11,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    categoryOptionActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
    categoryOptionIcon: {
      width: 35,
      height: 35,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMuted,
    },
    categoryOptionIconActive: { backgroundColor: colors.accent },
    categoryOptionTitle: { color: colors.text, fontSize: 11.5, fontWeight: '900' },
    categoryOptionDescription: { color: colors.textMuted, fontSize: 9.5, marginTop: 2 },
    textInput: {
      minHeight: 46,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      color: colors.text,
      fontSize: 12.5,
      paddingHorizontal: 13,
      paddingVertical: 11,
    },
    largeTextInput: { minHeight: 132, lineHeight: 18 },
    diagnosticsCard: {
      marginTop: 15,
      padding: 13,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.infoSoft,
    },
    diagnosticsHeading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    diagnosticsIcon: {
      width: 34,
      height: 34,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
    },
    diagnosticsTitle: { color: colors.text, fontSize: 11.5, fontWeight: '900' },
    diagnosticsDescription: {
      color: colors.textSecondary,
      fontSize: 9.5,
      lineHeight: 14,
      marginTop: 2,
    },
    smallFieldLabel: {
      color: colors.textSecondary,
      fontSize: 9.5,
      fontWeight: '900',
      marginTop: 12,
      marginBottom: 5,
    },
    compactTextInput: {
      height: 42,
      borderRadius: 9,
      paddingHorizontal: 11,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      color: colors.text,
      fontSize: 11.5,
    },
    attachmentHeading: {
      marginTop: 18,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    attachButton: {
      height: 36,
      borderRadius: 9,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.accentSoft,
      borderWidth: 1,
      borderColor: colors.border,
    },
    attachButtonText: { color: colors.accent, fontSize: 10.5, fontWeight: '900' },
    pendingMediaRow: { gap: 9, paddingVertical: 10 },
    pendingMediaCard: {
      width: 88,
      borderRadius: 10,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    pendingMediaImage: { width: 86, height: 69, backgroundColor: colors.surfaceMuted },
    pendingVideoPreview: {
      width: 86,
      height: 69,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.graphiteSoft,
    },
    pendingMediaName: {
      color: colors.textSecondary,
      fontSize: 8.5,
      paddingHorizontal: 5,
      paddingVertical: 5,
    },
    removeMediaButton: {
      position: 'absolute',
      right: 4,
      top: 4,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: 'rgba(0,0,0,0.72)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    pendingProgressOverlay: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      height: 69,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.54)',
    },
    pendingProgressText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
    uploadedCheck: {
      position: 'absolute',
      left: 4,
      top: 4,
      width: 19,
      height: 19,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.success,
    },
    primaryButton: {
      height: 49,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 8,
      backgroundColor: colors.accent,
      marginTop: 21,
    },
    buttonDisabled: { opacity: 0.58 },
    primaryButtonText: { color: '#FFFFFF', fontSize: 12.5, fontWeight: '900' },
    messageList: { paddingHorizontal: 13, paddingTop: 12, paddingBottom: 18, flexGrow: 1 },
    loadEarlierButton: {
      alignSelf: 'center',
      height: 34,
      borderRadius: 17,
      paddingHorizontal: 13,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 10,
    },
    loadEarlierText: { color: colors.accent, fontSize: 9.5, fontWeight: '900' },
    threadContext: { alignItems: 'center', paddingVertical: 10 },
    threadContextText: { color: colors.textMuted, fontSize: 9.5, textAlign: 'center' },
    systemMessage: {
      alignSelf: 'center',
      maxWidth: '88%',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 7,
      marginVertical: 7,
      borderRadius: 12,
      backgroundColor: colors.surfaceMuted,
    },
    systemMessageText: {
      color: colors.textMuted,
      fontSize: 9.5,
      lineHeight: 14,
      textAlign: 'center',
    },
    messageRow: { flexDirection: 'row', alignItems: 'flex-end', marginVertical: 6 },
    messageRowOwn: { justifyContent: 'flex-end' },
    agentAvatar: {
      width: 28,
      height: 28,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.graphiteSoft,
      marginRight: 7,
      marginBottom: 18,
    },
    messageGroup: { maxWidth: '82%', alignItems: 'flex-start' },
    messageGroupOwn: { alignItems: 'flex-end' },
    senderName: {
      color: colors.textMuted,
      fontSize: 9,
      fontWeight: '800',
      marginLeft: 3,
      marginBottom: 4,
    },
    messageBubble: { borderRadius: 15, padding: 10, gap: 7 },
    ownBubble: { backgroundColor: colors.accent, borderBottomRightRadius: 4 },
    agentBubble: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderBottomLeftRadius: 4,
    },
    messageBody: { color: colors.text, fontSize: 12, lineHeight: 18 },
    ownMessageBody: { color: '#FFFFFF' },
    messageTime: { color: colors.textMuted, fontSize: 8.5, marginTop: 4, marginLeft: 3 },
    messageTimeOwn: { marginLeft: 0, marginRight: 3 },
    processingAttachment: {
      minWidth: 190,
      minHeight: 50,
      borderRadius: 9,
      paddingHorizontal: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.surfaceMuted,
    },
    processingAttachmentText: { color: colors.textMuted, fontSize: 9.5, flex: 1 },
    remoteImage: {
      width: 220,
      height: 165,
      borderRadius: 10,
      backgroundColor: colors.surfaceMuted,
    },
    remoteVideoCard: {
      width: 240,
      borderRadius: 10,
      overflow: 'hidden',
      backgroundColor: colors.graphite,
    },
    remoteVideo: { width: 240, height: 155, backgroundColor: '#000000' },
    openMediaRow: {
      minHeight: 35,
      paddingHorizontal: 9,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    openMediaText: { color: '#D9E0E9', fontSize: 9.5, flex: 1 },
    inlineError: { alignItems: 'center', padding: 24, gap: 8 },
    inlineErrorText: { color: colors.textSecondary, fontSize: 11, textAlign: 'center' },
    retryText: { color: colors.accent, fontSize: 11, fontWeight: '900' },
    composerContainer: {
      paddingHorizontal: 10,
      paddingTop: 7,
      paddingBottom: 8,
      backgroundColor: colors.surface,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 7 },
    composerAttachButton: {
      width: 40,
      height: 40,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMuted,
      borderWidth: 1,
      borderColor: colors.border,
    },
    composerInput: {
      flex: 1,
      minHeight: 40,
      maxHeight: 112,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: colors.surfaceMuted,
      color: colors.text,
      fontSize: 12,
    },
    sendButton: {
      width: 40,
      height: 40,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
    },
    sendButtonDisabled: { opacity: 0.4 },
    closedComposer: {
      minHeight: 58,
      paddingHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
      backgroundColor: colors.surface,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    closedComposerText: { color: colors.textMuted, fontSize: 10.5, lineHeight: 15, flex: 1 },
    imagePreviewModal: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.96)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    imagePreviewClose: {
      position: 'absolute',
      top: 48,
      right: 18,
      zIndex: 2,
      width: 42,
      height: 42,
      borderRadius: 21,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.16)',
    },
    imagePreview: { width: '100%', height: '84%' },
  });
