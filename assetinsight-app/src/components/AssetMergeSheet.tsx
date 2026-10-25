import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import assetService, {
  type AssetMergeCandidate,
  type AssetMergeResult,
} from "../services/assetService";

type Props = {
  visible: boolean;
  anchorReportId: string | null;
  onClose: () => void;
  onCreated: (result: AssetMergeResult) => void;
};

const MAX_MERGE_SOURCES = 20;

function createRequestId() {
  return `merge-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export default function AssetMergeSheet({ visible, anchorReportId, onClose, onCreated }: Props) {
  const [candidates, setCandidates] = useState<AssetMergeCandidate[]>([]);
  const [contractNo, setContractNo] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [primaryId, setPrimaryId] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef("");

  useEffect(() => {
    if (!visible || !anchorReportId) return;
    let active = true;
    setLoading(true);
    setError(null);
    setSelectedIds([]);
    setPrimaryId("");
    const requestStorageKey = `asset-merge-request:${anchorReportId}`;
    void AsyncStorage.getItem(requestStorageKey)
      .then(async (retainedRequestId) => {
        requestIdRef.current = retainedRequestId || createRequestId();
        if (!retainedRequestId) {
          await AsyncStorage.setItem(requestStorageKey, requestIdRef.current);
        }
        return assetService.getMergeCandidates(anchorReportId);
      })
      .then((response) => {
        if (!active) return;
        setCandidates(response.candidates);
        setContractNo(response.contractNo);
        const anchor = response.candidates.find(
          (candidate) => candidate.id === anchorReportId && candidate.eligible
        );
        if (anchor) {
          setSelectedIds([anchor.id]);
          setPrimaryId(anchor.id);
        }
      })
      .catch((requestError: any) => {
        if (!active) return;
        setError(
          requestError?.response?.data?.message ||
            requestError?.message ||
            "Unable to load matching Asset reports."
        );
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [anchorReportId, visible]);

  const selected = useMemo(
    () => candidates.filter((candidate) => selectedIds.includes(candidate.id)),
    [candidates, selectedIds]
  );
  const eligibleCount = useMemo(
    () => candidates.filter((candidate) => candidate.eligible).length,
    [candidates]
  );
  const totals = useMemo(
    () => ({
      reports: selected.length,
      lots: selected.reduce((sum, item) => sum + item.lotCount, 0),
      images: selected.reduce((sum, item) => sum + item.imageCount, 0),
    }),
    [selected]
  );
  const toggleCandidate = (candidate: AssetMergeCandidate) => {
    if (!candidate.eligible) return;
    if (!selectedIds.includes(candidate.id) && selectedIds.length >= MAX_MERGE_SOURCES) {
      Alert.alert("Selection limit", `Select no more than ${MAX_MERGE_SOURCES} Asset reports.`);
      return;
    }
    setSelectedIds((current) => {
      if (current.includes(candidate.id)) {
        const next = current.filter((id) => id !== candidate.id);
        if (primaryId === candidate.id) setPrimaryId(next[0] || "");
        return next;
      }
      const next = [...current, candidate.id];
      if (!primaryId) setPrimaryId(candidate.id);
      return next;
    });
  };

  const submit = async () => {
    if (selectedIds.length < 2 || !primaryId) return;
    try {
      setSubmitting(true);
      setError(null);
      const result = await assetService.mergeReports({
        sourceReportIds: selectedIds,
        primaryReportId: primaryId,
        mergeRequestId: requestIdRef.current,
      });
      if (anchorReportId) {
        await AsyncStorage.removeItem(`asset-merge-request:${anchorReportId}`);
      }
      Alert.alert(
        "Merged preview created",
        "The combined Asset preview is being prepared with sequential lot numbers."
      );
      onCreated(result);
    } catch (requestError: any) {
      setError(
        requestError?.response?.data?.message ||
          requestError?.message ||
          "Unable to merge Asset reports."
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={submitting ? undefined : onClose}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} disabled={submitting} style={styles.iconButton}>
            <Feather name="x" size={22} color="#111827" />
          </TouchableOpacity>
          <View style={styles.headerText}>
            <Text style={styles.title}>Merge Asset Reports</Text>
            <Text style={styles.subtitle}>Contract {contractNo || "-"}</Text>
          </View>
          <View style={styles.iconPlaceholder} />
        </View>

        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator size="large" color="#F43F5E" />
            <Text style={styles.loadingText}>Loading matching reports...</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.summary}>
              {[
                ["Reports", totals.reports],
                ["Lots", totals.lots],
                ["Images", totals.images],
              ].map(([label, value]) => (
                <View key={String(label)} style={styles.summaryItem}>
                  <Text style={styles.summaryValue}>{value}</Text>
                  <Text style={styles.summaryLabel}>{label}</Text>
                </View>
              ))}
            </View>

            {error ? (
              <View style={styles.errorBox}>
                <Feather name="alert-circle" size={18} color="#B91C1C" />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
            {selected.length >= 2 ? (
              <View style={styles.infoBox}>
                <Feather name="info" size={18} color="#1D4ED8" />
                <Text style={styles.infoText}>
                  Lots will be ordered and renumbered automatically from Lot 1 through Lot {totals.lots}.
                </Text>
              </View>
            ) : null}
            {eligibleCount < 2 ? (
              <Text style={styles.emptyText}>No other eligible Asset reports use this exact contract number.</Text>
            ) : null}

            {candidates.map((candidate) => {
              const selected = selectedIds.includes(candidate.id);
              const primary = primaryId === candidate.id;
              return (
                <TouchableOpacity
                  key={candidate.id}
                  activeOpacity={candidate.eligible ? 0.78 : 1}
                  onPress={() => toggleCandidate(candidate)}
                  style={[
                    styles.card,
                    selected && styles.cardSelected,
                    !candidate.eligible && styles.cardDisabled,
                  ]}
                >
                  {candidate.thumbnailUrl ? (
                    <Image source={{ uri: candidate.thumbnailUrl }} style={styles.thumbnail} resizeMode="cover" />
                  ) : (
                    <View style={[styles.thumbnail, styles.thumbnailFallback]}>
                      <Feather name="package" size={22} color="#64748B" />
                    </View>
                  )}
                  <View style={styles.cardBody}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{candidate.clientName}</Text>
                    <Text style={styles.cardMeta}>
                      {new Date(candidate.createdAt).toLocaleDateString()} · {candidate.lotCount} lots · {candidate.imageCount} images
                    </Text>
                    {candidate.owner?.email || candidate.owner?.name ? (
                      <Text style={styles.cardOwner} numberOfLines={1}>
                        Created by {candidate.owner.email || candidate.owner.name}
                      </Text>
                    ) : null}
                    <Text style={styles.cardLots} numberOfLines={2}>
                      {candidate.lotNumbers.length
                        ? candidate.lotNumbers.map((value) => `Lot ${value}`).join(", ")
                        : "No lot numbers"}
                    </Text>
                    {!candidate.eligible ? <Text style={styles.disabledReason}>{candidate.disabledReason}</Text> : null}
                    {candidate.isMergedReport ? <Text style={styles.mergedLabel}>Previously merged report</Text> : null}
                  </View>
                  <View style={styles.controls}>
                    <View style={[styles.check, selected && styles.checkSelected]}>
                      {selected ? <Feather name="check" size={15} color="#fff" /> : null}
                    </View>
                    <TouchableOpacity
                      disabled={!selected}
                      onPress={() => setPrimaryId(candidate.id)}
                      style={[styles.radio, primary && styles.radioSelected, !selected && styles.radioDisabled]}
                    >
                      {primary ? <View style={styles.radioDot} /> : null}
                    </TouchableOpacity>
                    <Text style={styles.primaryLabel}>{primary ? "Primary" : ""}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
            <Text style={styles.helpText}>
              The Primary report supplies shared client, date, location, signature, and appraisal settings. Source reports are never changed.
            </Text>
          </ScrollView>
        )}

        <View style={styles.footer}>
          <TouchableOpacity style={styles.cancelButton} onPress={onClose} disabled={submitting}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.mergeButton,
              (selectedIds.length < 2 || !primaryId || submitting || loading) && styles.buttonDisabled,
            ]}
            disabled={selectedIds.length < 2 || !primaryId || submitting || loading}
            onPress={submit}
          >
            {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Feather name="git-merge" size={18} color="#fff" />}
            <Text style={styles.mergeButtonText}>{submitting ? "Creating..." : "Create merged preview"}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F8FAFC" },
  header: { minHeight: 68, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: "#E2E8F0", backgroundColor: "#fff" },
  iconButton: { width: 42, height: 42, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#F1F5F9" },
  iconPlaceholder: { width: 42 },
  headerText: { flex: 1, alignItems: "center" },
  title: { color: "#0F172A", fontSize: 19, fontWeight: "900" },
  subtitle: { color: "#64748B", fontSize: 13, marginTop: 2 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { marginTop: 12, color: "#64748B", fontWeight: "600" },
  content: { padding: 16, paddingBottom: 28, gap: 12 },
  summary: { flexDirection: "row", backgroundColor: "#fff", borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 14, paddingVertical: 14 },
  summaryItem: { flex: 1, alignItems: "center" },
  summaryValue: { color: "#0F172A", fontSize: 20, fontWeight: "900" },
  summaryLabel: { color: "#64748B", fontSize: 12, marginTop: 2 },
  errorBox: { flexDirection: "row", gap: 9, padding: 12, borderRadius: 12, backgroundColor: "#FEF2F2", borderWidth: 1, borderColor: "#FECACA" },
  errorText: { flex: 1, color: "#B91C1C", fontSize: 13, fontWeight: "600" },
  infoBox: { flexDirection: "row", gap: 9, padding: 12, borderRadius: 12, backgroundColor: "#EFF6FF", borderWidth: 1, borderColor: "#BFDBFE" },
  infoText: { flex: 1, color: "#1E40AF", fontSize: 13, fontWeight: "600" },
  emptyText: { padding: 20, textAlign: "center", color: "#64748B", backgroundColor: "#fff", borderRadius: 12 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: "#E2E8F0", backgroundColor: "#fff" },
  cardSelected: { borderColor: "#F43F5E", backgroundColor: "#FFF1F2" },
  cardDisabled: { opacity: 0.52 },
  thumbnail: { width: 66, height: 58, borderRadius: 9, backgroundColor: "#E2E8F0" },
  thumbnailFallback: { alignItems: "center", justifyContent: "center" },
  cardBody: { flex: 1, minWidth: 0 },
  cardTitle: { color: "#0F172A", fontSize: 15, fontWeight: "800" },
  cardMeta: { color: "#475569", fontSize: 12, marginTop: 3 },
  cardOwner: { color: "#64748B", fontSize: 11, marginTop: 2 },
  cardLots: { color: "#64748B", fontSize: 12, marginTop: 3 },
  disabledReason: { color: "#B91C1C", fontSize: 11, marginTop: 4, fontWeight: "600" },
  mergedLabel: { color: "#2563EB", fontSize: 11, marginTop: 4, fontWeight: "700" },
  controls: { width: 58, alignItems: "center", gap: 6 },
  check: { width: 24, height: 24, borderRadius: 6, borderWidth: 1.5, borderColor: "#94A3B8", alignItems: "center", justifyContent: "center" },
  checkSelected: { backgroundColor: "#F43F5E", borderColor: "#F43F5E" },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: "#94A3B8", alignItems: "center", justifyContent: "center" },
  radioSelected: { borderColor: "#2563EB" },
  radioDisabled: { opacity: 0.35 },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#2563EB" },
  primaryLabel: { minHeight: 14, color: "#2563EB", fontSize: 10, fontWeight: "800" },
  helpText: { color: "#64748B", fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
  footer: { flexDirection: "row", gap: 10, padding: 16, borderTopWidth: 1, borderTopColor: "#E2E8F0", backgroundColor: "#fff" },
  cancelButton: { height: 48, paddingHorizontal: 22, borderRadius: 12, borderWidth: 1, borderColor: "#CBD5E1", alignItems: "center", justifyContent: "center" },
  cancelText: { color: "#334155", fontWeight: "800" },
  mergeButton: { flex: 1, height: 48, borderRadius: 12, backgroundColor: "#F43F5E", flexDirection: "row", gap: 9, alignItems: "center", justifyContent: "center" },
  mergeButtonText: { color: "#fff", fontWeight: "900" },
  buttonDisabled: { opacity: 0.45 },
});
