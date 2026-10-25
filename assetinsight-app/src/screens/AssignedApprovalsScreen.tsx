import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import KeyboardSafeViewport from "../components/KeyboardSafeViewport";
import { useAppTheme, type AppThemeColors } from "../context/ThemeContext";
import assignedApprovalService, {
  type AssignedApproval,
} from "../services/assignedApprovalService";

interface AssignedApprovalsScreenProps {
  onOpenDrawer: () => void;
  onOpenPreview: (
    reportId: string,
    reportType: "Asset" | "RealEstate" | "Salvage",
    source: "assignedApproval"
  ) => void;
}

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function getTitle(item: AssignedApproval) {
  return item.address || item.filename || item.contract_no || "Assigned report";
}

export default function AssignedApprovalsScreen({
  onOpenDrawer,
  onOpenPreview,
}: AssignedApprovalsScreenProps) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [items, setItems] = useState<AssignedApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<AssignedApproval | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const editableItems = useMemo(
    () => items.filter((item) => item.isAssetReport || item.isRealEstateReport),
    [items]
  );

  const load = useCallback(async () => {
    try {
      const data = await assignedApprovalService.getAssignedApprovals();
      setItems(data.items || []);
    } catch (error: any) {
      Alert.alert("Approvals", error?.response?.data?.message || "Failed to load assigned approvals.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = async (item: AssignedApproval) => {
    setBusyId(item._id);
    try {
      await assignedApprovalService.approve(item._id);
      await load();
      Alert.alert("Approved", "Report approved successfully.");
    } catch (error: any) {
      Alert.alert("Approve failed", error?.response?.data?.message || "Failed to approve report.");
    } finally {
      setBusyId(null);
    }
  };

  const reject = async () => {
    if (!rejectTarget) return;
    const note = rejectNote.trim();
    if (!note) {
      Alert.alert("Rejection note", "Please enter a note.");
      return;
    }
    setBusyId(rejectTarget._id);
    try {
      await assignedApprovalService.reject(rejectTarget._id, note);
      setRejectTarget(null);
      setRejectNote("");
      await load();
      Alert.alert("Rejected", "Report was sent back with your note.");
    } catch (error: any) {
      Alert.alert("Reject failed", error?.response?.data?.message || "Failed to reject report.");
    } finally {
      setBusyId(null);
    }
  };

  const renderItem = ({ item }: { item: AssignedApproval }) => {
    const reportType = item.reportType === "Salvage" ? "Salvage" : item.isRealEstateReport ? "RealEstate" : "Asset";
    const canEdit = item.isAssetReport || item.isRealEstateReport || item.reportType === "Salvage";
    const busy = busyId === item._id;
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.typeBadge}>
            <Text style={styles.typeBadgeText}>{item.reportType}</Text>
          </View>
          <Text style={styles.pendingText}>Pending</Text>
        </View>
        <Text style={styles.title}>{getTitle(item)}</Text>
        <Text style={styles.meta}>
          {item.contract_no ? `Contract ${item.contract_no} - ` : ""}
          {item.fairMarketValue || "Value not set"}
        </Text>
        <Text style={styles.meta}>
          Submitted by {item.user?.username || item.user?.email || "User"}
          {formatDate(item.createdAt) ? ` - ${formatDate(item.createdAt)}` : ""}
        </Text>
        <View style={styles.actions}>
          {canEdit ? (
            <TouchableOpacity
              style={[styles.actionBtn, styles.reviewBtn]}
              disabled={busy}
              onPress={() => onOpenPreview(item._id, reportType, "assignedApproval")}
              activeOpacity={0.86}
            >
              <Feather name="edit-3" size={15} color={colors.info} />
              <Text style={[styles.actionText, styles.reviewText]}>{item.reportType === "Salvage" ? "Review" : "Review / Edit"}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={[styles.actionBtn, styles.approveBtn]}
            disabled={busy}
            onPress={() => void approve(item)}
            activeOpacity={0.86}
          >
            {busy ? <ActivityIndicator size="small" color={colors.accentText} /> : <Feather name="check" size={15} color={colors.accentText} />}
            <Text style={[styles.actionText, styles.approveText]}>Approve</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, styles.rejectBtn]}
            disabled={busy}
            onPress={() => {
              setRejectTarget(item);
              setRejectNote("");
            }}
            activeOpacity={0.86}
          >
            <Feather name="x" size={15} color={colors.danger} />
            <Text style={[styles.actionText, styles.rejectText]}>Reject</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.iconBtn} onPress={onOpenDrawer} activeOpacity={0.85}>
          <Feather name="menu" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text style={styles.heading}>Assigned Approvals</Text>
          <Text style={styles.subheading}>{editableItems.length} editable pending report(s)</Text>
        </View>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={() => {
            setRefreshing(true);
            void load();
          }}
          activeOpacity={0.85}
        >
          <Feather name="refresh-cw" size={18} color={colors.text} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item._id}
          renderItem={renderItem}
          contentContainerStyle={items.length ? styles.listContent : styles.emptyContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.accent}
              colors={[colors.accent]}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyCard}>
              <Feather name="check-circle" size={34} color={colors.success} />
              <Text style={styles.emptyTitle}>No assigned approvals</Text>
              <Text style={styles.emptyText}>Reports assigned to you will appear here.</Text>
            </View>
          }
        />
      )}

      <Modal visible={Boolean(rejectTarget)} transparent animationType="fade" onRequestClose={() => setRejectTarget(null)}>
        <KeyboardSafeViewport
          testID="rejection-keyboard-container"
          style={styles.modalBackdrop}
        >
          <SafeAreaView style={styles.modalSafeArea} edges={["top", "bottom", "left", "right"]}>
            <ScrollView
              testID="rejection-scroll-container"
              style={styles.modalScroll}
              contentContainerStyle={styles.modalScrollContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            >
              <View style={styles.modalCard} accessibilityViewIsModal>
                <Text style={styles.modalTitle} accessibilityRole="header">Reject report</Text>
                <Text style={styles.modalText}>Add a clear note so the report creator knows what to fix.</Text>
                <TextInput
                  value={rejectNote}
                  onChangeText={setRejectNote}
                  placeholder="Rejection note"
                  accessibilityLabel="Rejection note"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  style={styles.rejectInput}
                  textAlignVertical="top"
                />
                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={styles.cancelBtn}
                    onPress={() => setRejectTarget(null)}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel rejection"
                  >
                    <Text style={styles.cancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.confirmRejectBtn}
                    onPress={() => void reject()}
                    accessibilityRole="button"
                    accessibilityLabel="Confirm report rejection"
                  >
                    <Text style={styles.confirmRejectText}>Reject</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </ScrollView>
          </SafeAreaView>
        </KeyboardSafeViewport>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = (colors: AppThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerText: {
    flex: 1,
  },
  heading: {
    color: colors.text,
    fontSize: 21,
    fontWeight: "900",
  },
  subheading: {
    color: colors.textMuted,
    marginTop: 2,
    fontSize: 11,
  },
  listContent: {
    padding: 14,
    gap: 12,
    paddingBottom: 28,
  },
  emptyContent: {
    flexGrow: 1,
    padding: 18,
    justifyContent: "center",
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 14,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 4,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  typeBadge: {
    backgroundColor: colors.infoSoft,
    borderRadius: 7,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  typeBadgeText: {
    color: colors.info,
    fontSize: 10.5,
    fontWeight: "800",
  },
  pendingText: {
    color: colors.warning,
    fontSize: 10.5,
    fontWeight: "700",
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "800",
  },
  meta: {
    color: colors.textMuted,
    fontSize: 11.5,
    marginTop: 5,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 14,
  },
  actionBtn: {
    minHeight: 40,
    borderRadius: 9,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  reviewBtn: {
    backgroundColor: colors.infoSoft,
  },
  approveBtn: {
    backgroundColor: colors.success,
  },
  rejectBtn: {
    backgroundColor: colors.dangerSoft,
  },
  actionText: {
    fontSize: 13,
    fontWeight: "800",
  },
  reviewText: {
    color: colors.info,
  },
  approveText: {
    color: colors.accentText,
  },
  rejectText: {
    color: colors.danger,
  },
  emptyCard: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 28,
  },
  emptyTitle: {
    marginTop: 12,
    color: colors.text,
    fontSize: 18,
    fontWeight: "800",
  },
  emptyText: {
    marginTop: 5,
    color: colors.textMuted,
    textAlign: "center",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
  },
  modalSafeArea: {
    flex: 1,
  },
  modalScroll: {
    flex: 1,
  },
  modalScrollContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
  },
  modalCard: {
    width: "100%",
    maxWidth: 460,
    borderRadius: 10,
    backgroundColor: colors.surface,
    padding: 18,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "800",
  },
  modalText: {
    color: colors.textMuted,
    marginTop: 6,
    marginBottom: 12,
  },
  rejectInput: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 9,
    padding: 12,
    color: colors.text,
    backgroundColor: colors.surfaceMuted,
  },
  modalActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 14,
  },
  cancelBtn: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 9,
    backgroundColor: colors.surfaceMuted,
  },
  cancelText: {
    color: colors.textSecondary,
    fontWeight: "800",
  },
  confirmRejectBtn: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 9,
    backgroundColor: colors.danger,
  },
  confirmRejectText: {
    color: "#FFFFFF",
    fontWeight: "800",
  },
});
