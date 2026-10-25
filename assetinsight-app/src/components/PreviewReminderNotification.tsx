import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "../context/ThemeContext";
import type { NotificationItem } from "../services/notificationService";
import { fetchNotification } from "../services/notificationService";
import { previewReminderDetails } from "../utils/previewReminderNotification";

type Props = {
  item: NotificationItem;
  onClose: () => void;
  onOpenPreview: (reportId: string, reportType: "Asset" | "LotListing", mode: "pending") => void;
  onOpenDrafts?: () => void;
};

/** One read-only message surface for inbox and push taps; no submission side effects. */
export default function PreviewReminderNotification({ item, onClose, onOpenPreview, onOpenDrafts }: Props) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [resolved, setResolved] = useState<NotificationItem | null>(() => item.requiresDetails ? null : item);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!item.requiresDetails) return;
    const controller = new AbortController();
    void fetchNotification(item.id, controller.signal).then((full) => {
      if (!previewReminderDetails(full)) throw new Error("Notification unavailable");
      if (!controller.signal.aborted) setResolved(full);
    }).catch((error: { response?: { status?: number } }) => {
      if (!controller.signal.aborted) setLoadError(error?.response?.status === 404
        ? "This notification is no longer available for this account."
        : "The full message could not be loaded. Check your connection and try again.");
    });
    return () => controller.abort();
  }, [item.id, item.requiresDetails, attempt]);
  const detail = resolved ? previewReminderDetails(resolved) : null;
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <View style={[styles.overlay, { backgroundColor: colors.overlay, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessible={false} />
      <View accessibilityViewIsModal style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border, maxHeight: Math.max(180, height - insets.top - insets.bottom - 24) }]}>
        <View style={[styles.header, { borderColor: colors.border }]}>
          <Text accessibilityRole="header" style={[styles.headerTitle, { color: colors.text }]}>Report notification</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close report notification" onPress={onClose} style={styles.close}>
            <Text style={{ color: colors.accent, fontWeight: "700" }}>Close</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} accessibilityLabel="Report notification details">
          {!detail ? loadError ? <View style={styles.steps}>
            <Text accessibilityRole="alert" style={[styles.body, { color: colors.text }]}>{loadError}</Text>
            <Pressable accessibilityRole="button" onPress={() => { setLoadError(""); setAttempt((value) => value + 1); }} style={[styles.open, { backgroundColor: colors.accent }]}>
              <Text style={[styles.openText, { color: colors.accentText }]}>Retry loading message</Text>
            </Pressable>
          </View> : <View style={styles.steps}>
            <ActivityIndicator color={colors.accent} />
            <Text accessibilityRole="alert" style={[styles.body, { color: colors.text }]}>Loading full message…</Text>
          </View> : <>
          <Text selectable accessibilityRole="header" style={[styles.subject, { color: colors.text }]}>{detail.subject}</Text>
          <View style={[styles.metadata, { borderColor: colors.border }]}>
            <Text style={[styles.meta, { color: colors.textSecondary }]}>From: Asset Insight Operations</Text>
            <Text selectable style={[styles.meta, { color: colors.textSecondary }]}>{detail.reportLabel}{detail.contractNo ? ` · ${detail.contractNo}` : ""}</Text>
          </View>
          <Text selectable style={[styles.body, { color: colors.text }]}>{detail.message}</Text>
          {detail.reportError ? <View style={[styles.issue, { backgroundColor: colors.dangerSoft, borderColor: colors.danger }]}>
            <Text accessibilityRole="header" style={[styles.label, { color: colors.text }]}>Reported issue</Text>
            <Text selectable style={[styles.body, { color: colors.text }]}>{detail.reportError}</Text>
          </View> : null}
          {detail.correctionSteps.length ? <View style={styles.steps}>
            <Text accessibilityRole="header" style={[styles.label, { color: colors.text }]}>What to do next</Text>
            {detail.correctionSteps.map((step, index) => <Text key={index} selectable style={[styles.body, { color: colors.text }]}>{index + 1}. {step}</Text>)}
          </View> : null}
          <Text style={[styles.note, { color: colors.textSecondary }]}>This message records the report state when it was sent. Open the preview to check the latest status.</Text>
          {detail.isDraft && onOpenDrafts ? <Pressable accessibilityRole="button" onPress={() => { onClose(); onOpenDrafts(); }} style={[styles.open, { backgroundColor: colors.accent }]}>
            <Text style={[styles.openText, { color: colors.accentText }]}>Open drafts</Text>
          </Pressable> : detail.target ? <Pressable accessibilityRole="button" onPress={() => {
            const target = detail.target;
            if (!target) return;
            onClose();
            onOpenPreview(target.reportId, target.reportType, target.mode);
          }} style={[styles.open, { backgroundColor: colors.accent }]}>
            <Text style={[styles.openText, { color: colors.accentText }]}>Open related preview</Text>
          </Pressable> : <Text style={[styles.note, { color: colors.textSecondary }]}>A valid related preview link is not available. Find the report in Previews or contact Operations.</Text>}
          </>}
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 12 },
  panel: { width: "100%", maxWidth: 620, flexShrink: 1, borderWidth: 1, borderRadius: 12, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 16, paddingRight: 8, borderBottomWidth: 1, gap: 8 },
  headerTitle: { fontSize: 16, fontWeight: "700", flexShrink: 1 },
  close: { minHeight: 48, minWidth: 60, alignItems: "center", justifyContent: "center", padding: 8 },
  scroll: { flexShrink: 1 },
  content: { padding: 18, gap: 16 },
  subject: { fontSize: 21, fontWeight: "700", lineHeight: 29 },
  metadata: { gap: 6, borderBottomWidth: 1, paddingBottom: 12 },
  meta: { fontSize: 13, lineHeight: 20 },
  body: { fontSize: 15, lineHeight: 23 },
  label: { fontSize: 14, lineHeight: 21, fontWeight: "700" },
  issue: { gap: 7, borderLeftWidth: 3, borderRadius: 4, padding: 12 },
  steps: { gap: 10 },
  note: { fontSize: 12, lineHeight: 19 },
  open: { minHeight: 48, padding: 13, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  openText: { fontSize: 15, fontWeight: "700", textAlign: "center" },
});
