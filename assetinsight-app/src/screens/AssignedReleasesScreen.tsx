import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useAppTheme, type AppThemeColors } from "../context/ThemeContext";
import assignedReleaseService, { type AssignedRelease } from "../services/assignedReleaseService";

interface AssignedReleasesScreenProps {
  onOpenDrawer: () => void;
}

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function getTitle(item: AssignedRelease) {
  return item.address || item.filename || item.contract_no || "Assigned report";
}

export default function AssignedReleasesScreen({ onOpenDrawer }: AssignedReleasesScreenProps) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [items, setItems] = useState<AssignedRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await assignedReleaseService.getAssignedReleases();
      setItems(data.items || []);
    } catch (error: any) {
      Alert.alert("Releases", error?.response?.data?.message || "Failed to load assigned releases.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const releaseReport = async (item: AssignedRelease) => {
    setBusyId(item._id);
    try {
      await assignedReleaseService.release(item._id);
      await load();
      Alert.alert("Released", "The creator can now download this report.");
    } catch (error: any) {
      Alert.alert("Release failed", error?.response?.data?.message || "Failed to release report.");
    } finally {
      setBusyId(null);
    }
  };

  const renderItem = ({ item }: { item: AssignedRelease }) => {
    const busy = busyId === item._id;
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.typeBadge}>
            <Text style={styles.typeBadgeText}>{item.reportType}</Text>
          </View>
          <Text style={styles.pendingText}>Awaiting release</Text>
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
        <TouchableOpacity
          style={[styles.releaseBtn, busy && styles.releaseBtnDisabled]}
          disabled={busy}
          onPress={() => void releaseReport(item)}
          activeOpacity={0.86}
        >
          {busy ? <ActivityIndicator size="small" color={colors.accentText} /> : <Feather name="unlock" size={16} color={colors.accentText} />}
          <Text style={styles.releaseText}>{busy ? "Releasing..." : "Release"}</Text>
        </TouchableOpacity>
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
          <Text style={styles.heading}>Assigned Releases</Text>
          <Text style={styles.subheading}>{items.length} report(s) waiting for release</Text>
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
              <Text style={styles.emptyTitle}>No assigned releases</Text>
              <Text style={styles.emptyText}>Reports waiting for your release will appear here.</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const createStyles = (colors: AppThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
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
  headerText: { flex: 1 },
  heading: { fontSize: 21, fontWeight: "900", color: colors.text },
  subheading: { marginTop: 2, fontSize: 11, color: colors.textMuted, fontWeight: "700" },
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  listContent: { padding: 16, paddingBottom: 32 },
  emptyContent: { flexGrow: 1, padding: 16, justifyContent: "center" },
  card: {
    borderRadius: 10,
    padding: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 14,
    shadowColor: colors.shadow,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  typeBadge: { borderRadius: 7, paddingHorizontal: 9, paddingVertical: 4, backgroundColor: colors.infoSoft },
  typeBadgeText: { color: colors.info, fontWeight: "900", fontSize: 10.5 },
  pendingText: { color: colors.warning, fontWeight: "900", fontSize: 10.5 },
  title: { marginTop: 10, color: colors.text, fontSize: 16, fontWeight: "900" },
  meta: { marginTop: 5, color: colors.textMuted, fontSize: 11.5, fontWeight: "700" },
  releaseBtn: {
    marginTop: 16,
    minHeight: 48,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: colors.success,
  },
  releaseBtnDisabled: { opacity: 0.65 },
  releaseText: { color: colors.accentText, fontWeight: "900", fontSize: 14 },
  emptyCard: {
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyTitle: { marginTop: 12, color: colors.text, fontSize: 17, fontWeight: "900" },
  emptyText: { marginTop: 6, textAlign: "center", color: colors.textMuted, fontSize: 12 },
});
