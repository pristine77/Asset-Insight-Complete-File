import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import NetInfo from '@react-native-community/netinfo';
import { useAppTheme, type AppThemeColors } from '../context/ThemeContext';
import salvageService, {
  isSalvageGenerating,
  salvageSubmissionAction,
  type SalvageReport,
  type SalvageSnapshot,
} from '../services/salvageService';
import { downloadApprovedReportFile } from '../services/reportDownloadTransport';
import assignedApprovalService from '../services/assignedApprovalService';
import { clearSalvageResearchRequest, salvageResearchRequestId } from '../services/salvageResearchRequest';
import { isSalvageAssessmentV2 } from '../types/salvageAssessment';
import SalvageAssessmentEditor from '../components/reports/SalvageAssessmentEditor';
import SalvageProcessStatus from '../components/reports/SalvageProcessStatus';
import SalvageReportEnrichment from '../components/reports/SalvageReportEnrichment';
import SalvageReportContextEditor from '../components/reports/SalvageReportContextEditor';
import { salvageDisplayText } from '../utils/salvageDisplayText';

interface Props {
  reportId: string;
  onBack: () => void;
  readOnly?: boolean;
}
const sections = [
  [
    'Report & contacts',
    [
      'file_number',
      'report_date',
      'date_received',
      'claim_number',
      'policy_number',
      'date_of_loss',
      'reported_loss_type',
      'next_report_due',
      'appraiser_name',
      'appraiser_phone',
      'appraiser_email',
      'adjuster_name',
      'insured_name',
      'company_name',
      'company_address',
      'currency',
      'language',
    ],
  ],
  [
    'Vehicle & condition',
    [
      'item_type',
      'year',
      'make',
      'item_model',
      'vin',
      'item_condition',
      'damage_description',
      'inspection_comments',
      'cause_of_loss_summary',
      'appraiser_comments',
      'is_repairable',
      'repair_facility',
      'repair_facility_comments',
    ],
  ],
  [
    'Values & repair notes',
    [
      'actual_cash_value',
      'replacement_cost',
      'recommended_reserve',
      'labour_rate_default',
      'replacement_cost_references',
      'procurement_notes',
      'assumptions',
      'safety_concerns',
      'priority_level',
    ],
  ],
] as const;
const label = (key: string) =>
  key.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const text = (value: unknown) => (value == null ? '' : String(value));
const numericFields = new Set([
  'actual_cash_value',
  'replacement_cost',
  'recommended_reserve',
  'labour_rate_default',
  'quantity',
  'unit_price',
  'hours',
  'rate_per_hour',
  'lead_time_days',
]);
const errorMessage = (error: any) =>
  salvageDisplayText(error?.response?.data?.message || error?.message || 'Please check your connection and try again.');

export default function SalvagePreviewScreen({ reportId, onBack, readOnly = false }: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [report, setReport] = useState<SalvageReport | null>(null);
  const [data, setData] = useState<SalvageSnapshot>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(readOnly);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [openSection, setOpenSection] = useState('Vehicle & condition');
  const [downloadKey, setDownloadKey] = useState('');
  const [pollEpoch, setPollEpoch] = useState(0);
  const actionRef = useRef(false);
  const mutationEpoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applyReport = useCallback((next: SalvageReport) => {
    setReport(next);
    setData(next.preview_data || {});
    setDirty(false);
    setConflict(false);
  }, []);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = readOnly
        ? await assignedApprovalService.getPreview(reportId)
        : await salvageService.getPreview(reportId);
      if (mounted.current) {
        applyReport(next);
        setError('');
        setPollEpoch((current) => current + 1);
      }
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [reportId, applyReport, readOnly]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const generating = report ? isSalvageGenerating(report) : false;

  // Only poll accepted background work. Requests are serialized, bounded and disposed.
  useEffect(() => {
    if (!generating || readOnly) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The server budget is fifteen minutes; allow room for queue delay and
    // publication. Refresh/reconnection can safely resume read-only polling.
    const deadline = Date.now() + 20 * 60_000;
    let failures = 0;
    let inFlight = false;
    let finished = false;
    const poll = async () => {
      if (stopped || inFlight || finished) return;
      if (AppState.currentState && AppState.currentState !== 'active') {
        timer = setTimeout(() => { void poll(); }, 15000);
        return;
      }
      inFlight = true;
      const startedEpoch = mutationEpoch.current;
      try {
        const next = await salvageService.getPreview(reportId);
        if (stopped || actionRef.current || startedEpoch !== mutationEpoch.current) return;
        failures = 0;
        applyReport(next);
        setError('');
        if (!isSalvageGenerating(next)) { finished = true; return; }
      } catch {
        failures += 1;
      } finally {
        inFlight = false;
      }
      if (stopped) return;
      if (Date.now() >= deadline) {
        setError(
          'Processing may still be running. Refresh to check; do not create another report.'
        );
        return;
      }
      if (failures >= 5) setError('Connection interrupted. Reconnecting to this report; do not create another report.');
      timer = setTimeout(() => {
        void poll();
      }, Math.min(30000, 3000 * 2 ** Math.min(failures, 4)));
    };
    const reconnect = () => {
      if (stopped || finished || inFlight) return;
      if (timer) clearTimeout(timer);
      if (Date.now() >= deadline) setPollEpoch((current) => current + 1);
      else void poll();
    };
    const appState = AppState.addEventListener('change', (state) => { if (state === 'active') reconnect(); });
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) reconnect();
    });
    timer = setTimeout(() => {
      void poll();
    }, 3000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      appState.remove();
      unsubscribe();
    };
  }, [generating, reportId, applyReport, readOnly, pollEpoch]);

  const update = (key: string, value: unknown) => {
    setData((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
  };
  const handleSave = async (submit: boolean) => {
    if (!report || actionRef.current || generating || conflict || readOnly) return;
    actionRef.current = true;
    setBusy(true);
    setError('');
    try {
      let saved = report;
      if (dirty) saved = await salvageService.savePreview(reportId, data, report.revision);
      if (!mounted.current) return;
      // Saving and submitting are separate, revision-checked requests. Never replay a failed POST.
      applyReport(saved);
      if (submit) {
        const accepted = await salvageService.submit(saved);
        if (mounted.current) {
          if (accepted.data) applyReport(accepted.data);
          else await reload();
          setPreviewOpen(false);
        }
      }
    } catch (failure: any) {
      if (mounted.current) {
        const stale = failure?.response?.status === 409;
        setConflict(stale);
        setError(
          stale
            ? 'This report changed elsewhere. Your edits are still shown. Reload the latest version before making more changes; reloading discards these unsaved edits.'
            : errorMessage(failure)
        );
      }
    } finally {
      actionRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const retry = async () => {
    if (actionRef.current || !report || readOnly) return;
    actionRef.current = true;
    setBusy(true);
    try {
      const accepted = await salvageService.retry(reportId, report.revision);
      if (mounted.current) {
        applyReport(accepted.data);
        setPreviewOpen(false);
        setError('');
      }
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure));
    } finally {
      actionRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const stopProcessing = async () => {
    if (!report || !report.job_id || !report.can_cancel || actionRef.current || readOnly) return;
    actionRef.current = true;
    mutationEpoch.current += 1;
    setBusy(true);
    setStopping(true);
    setError('');
    try {
      const stopped = await salvageService.cancel(reportId, report.revision, report.job_id);
      if (isSalvageGenerating(stopped.data)) throw new Error('The server has not confirmed that processing stopped.');
      if (mounted.current) { applyReport(stopped.data); setPreviewOpen(false); }
    } catch (failure) {
      if (mounted.current) setError(`Stop not confirmed. Processing may still be running. Refresh before editing. ${errorMessage(failure)}`);
    } finally {
      actionRef.current = false;
      if (mounted.current) { setBusy(false); setStopping(false); setPollEpoch((value) => value + 1); }
    }
  };
  const confirmStop = () => {
    if (actionRef.current || !report?.can_cancel || !report.job_id || readOnly) return;
    Alert.alert('Stop report processing?', 'Saved photos and completed work will be retained. A request already in progress may still finish, but stopped work cannot publish new files. Wait for confirmation before editing or resuming.', [
      { text: 'Keep processing', style: 'cancel' },
      { text: 'Stop processing', style: 'destructive', onPress: () => { void stopProcessing(); } },
    ]);
  };
  const confirmReload = () => {
    if (!dirty && !conflict) {
      void reload();
      return;
    }
    Alert.alert('Reload latest preview?', 'Your unsaved changes will be discarded.', [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Reload',
        style: 'destructive',
        onPress: () => {
          void reload();
        },
      },
    ]);
  };
  const research = async () => {
    if (!report || actionRef.current || readOnly || dirty || conflict || generating || loading) return;
    actionRef.current = true;
    setBusy(true);
    setError('');
    try {
      const requestId = await salvageResearchRequestId(reportId, report.revision);
      const accepted = await salvageService.research(reportId, report.revision, requestId);
      await clearSalvageResearchRequest(reportId, report.revision);
      if (mounted.current) { applyReport(accepted.data); setPreviewOpen(false); }
    } catch (failure: any) {
      if (mounted.current) {
        setConflict(failure?.response?.data?.code === 'SALVAGE_REVISION_CONFLICT');
        setError(errorMessage(failure));
      }
    } finally {
      actionRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const confirmResearch = () => {
    if (!report || actionRef.current || readOnly || dirty || conflict || generating || loading) return;
    Alert.alert('Research again?',
      'Start a new research run from this saved revision? It can take up to 15 minutes. Files will need regeneration and approval. Ordinary saves do not run research.',
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Start research', onPress: () => { void research(); } }]);
  };
  const back = () => {
    if (busy) return;
    if (!dirty) {
      if (previewOpen && !readOnly) setPreviewOpen(false);
      else onBack();
      return;
    }
    Alert.alert('Leave unsaved changes?', 'Save your changes first or discard them to leave.', [
      { text: 'Stay', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => { setData(report?.preview_data || {}); setDirty(false); setPreviewOpen(false); } },
    ]);
  };
  const download = async (key: string, fileId: string) => {
    if (downloadKey) return;
    setDownloadKey(key);
    const extension = key === 'images' ? 'zip' : key;
    const path = `${FileSystem.cacheDirectory}salvage-${reportId}-${key}.${extension}`;
    try {
      const result = await downloadApprovedReportFile(fileId, path);
      if (result.status !== 200)
        throw new Error(
          'The file is not available for download. Refresh the report and check approval/release status.'
        );
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(result.uri);
      else throw new Error('File sharing is unavailable on this device.');
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure));
    } finally {
      await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
      if (mounted.current) setDownloadKey('');
    }
  };
  const canOpenPreview = !!report && !generating && (report.preview_available ?? (report.status !== 'error' && report.status !== 'cancelled' && Object.keys(data).length > 0));
  const editable = previewOpen && !readOnly && !generating && !busy && !stopping && !conflict && (report?.status !== 'error' || report.preview_available === true);
  const assessment = isSalvageAssessmentV2(data.assessment) ? data.assessment : null;
  const field = (key: string, value: unknown, change: (value: string) => void, prefix = '') => (
    <View key={key} style={styles.field}>
      <Text style={styles.label}>{label(key)}</Text>
      <TextInput
        accessibilityLabel={`${prefix}${label(key)}`}
        style={styles.input}
        value={text(value)}
        onChangeText={change}
        editable={editable}
        placeholderTextColor={colors.textMuted}
        keyboardType={
          numericFields.has(key) || typeof value === 'number' ? 'decimal-pad' : 'default'
        }
        multiline={!numericFields.has(key) && typeof value !== 'number'}
      />
    </View>
  );
  const rowFields = (key: 'repair_items' | 'labour_breakdown', keys: string[]) => {
    const rows: SalvageSnapshot[] = Array.isArray(data[key]) ? data[key] : [];
    return (
      <View>
        {rows.map((row, index) => (
          <View key={index} style={styles.rowCard}>
            <Text style={styles.heading}>
              {key === 'repair_items' ? 'Part' : 'Labour'} {index + 1}
            </Text>
            {keys.map((name) =>
              field(
                name,
                row[name],
                (value) =>
                  update(
                    key,
                    rows.map((entry, i) => (i === index ? { ...entry, [name]: value } : entry))
                  ),
                `${label(key)} ${index + 1} `
              )
            )}
            <Text style={styles.muted}>
              Saved line total: {text(row.line_total)} {data.currency || report?.currency}
            </Text>
            {!readOnly && (
              <TouchableOpacity
                disabled={!editable}
                onPress={() =>
                  update(
                    key,
                    rows.filter((_, i) => i !== index)
                  )
                }
                style={styles.smallButton}>
                <Text style={styles.danger}>
                  Remove {key === 'repair_items' ? 'part' : 'labour'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
        {!readOnly && (
          <TouchableOpacity
            disabled={!editable}
            style={styles.smallButton}
            onPress={() =>
              update(key, [
                ...rows,
                key === 'repair_items'
                  ? { name: '', quantity: 1, unit_price: 0 }
                  : { task: '', hours: 0, rate_per_hour: data.labour_rate_default || 0 },
              ])
            }>
            <Text style={styles.link}>Add {key === 'repair_items' ? 'part' : 'labour'}</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={back} disabled={busy} style={styles.smallButton}>
          <Text style={styles.link}>{previewOpen && !readOnly ? 'Close preview' : 'Back'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{previewOpen ? 'Salvage preview' : 'Salvage report'}</Text>
        <TouchableOpacity
          onPress={confirmReload}
          disabled={busy || loading}
          style={styles.smallButton}>
          <Text style={styles.link}>Refresh</Text>
        </TouchableOpacity>
      </View>
      {loading ? (
        <ActivityIndicator style={styles.loading} color={colors.accent} />
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {!!error && (
            <View style={styles.warning}>
              <Text style={styles.danger}>{error}</Text>
            </View>
          )}
          {report && (
            <>
              <Text style={styles.heading}>
                {report.file_number || data.file_number || 'Salvage report'}
              </Text>
              <Text style={styles.muted}>
                {previewOpen ? `${salvageDisplayText(report.workflow_message || label(report.workflow_stage || report.status))} · ` : ''}Revision {report.revision}
              </Text>
              {!previewOpen || generating ? (
                <SalvageProcessStatus report={report} busy={busy} stopping={stopping} canOpen={canOpenPreview}
                  readOnly={readOnly} onOpen={() => setPreviewOpen(true)} onStop={confirmStop} onRetry={() => { void retry(); }} />
              ) : (
                <>
                  {(report.status === 'error' ||
                    report.generation_state === 'error' ||
                    report.workflow_stage === 'error') && (
                    <View style={styles.warning}>
                      <Text style={styles.danger}>
                        {salvageDisplayText(report.job_error || 'Processing failed. Your report is retained.')}
                      </Text>
                      {!readOnly && (
                        <TouchableOpacity
                          onPress={() => {
                            void retry();
                          }}
                          disabled={busy}
                          style={styles.smallButton}>
                          <Text style={styles.link}>Retry processing</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                  {Object.keys(data).length > 0 && (
                    <>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={styles.photos}>
                        {(report.imageUrls || data.imageUrls || []).map(
                          (uri: string, index: number) => (
                            <Image
                              key={`${uri}-${index}`}
                              source={{ uri }}
                              style={styles.photo}
                              accessibilityLabel={`Source photo ${index + 1}`}
                            />
                          )
                        )}
                      </ScrollView>
                      <Text style={styles.muted}>
                        {readOnly
                          ? 'Read-only assigned review. Return to Assigned Approvals to approve or request changes.'
                          : 'Review the saved estimate before submitting. Saving recalculates repair totals; no photos are re-uploaded. Recorded evidence and source images are preserved.'}
                      </Text>
                      {!readOnly && <TouchableOpacity accessibilityRole="button" disabled={!editable || dirty} onPress={confirmResearch} style={styles.smallButton}>
                        <Text style={styles.link}>Research again</Text>
                      </TouchableOpacity>}
                      {!!data.estimate_warning && (
                        <Text style={styles.warning}>{salvageDisplayText(data.estimate_warning)}</Text>
                      )}
                      <SalvageReportEnrichment enrichment={data.report_enrichment} dirty={dirty} />
                      <SalvageReportContextEditor context={data.report_context} disabled={!editable}
                        onChange={(context) => update('report_context', context)} />
                      {assessment && <SalvageAssessmentEditor assessment={assessment}
                        inputs={data.assessment_inputs || assessment.inputs} disabled={!editable}
                        onChange={(inputs) => update('assessment_inputs', inputs)} photos={report.imageUrls || data.imageUrls || []} />}
                      {sections.filter(([title]) => !assessment || title !== 'Vehicle & condition').map(([title, keys]) => (
                        <View key={title} style={styles.panel}>
                          <TouchableOpacity
                            style={styles.sectionButton}
                            onPress={() => setOpenSection(openSection === title ? '' : title)}
                            accessibilityRole="button"
                            accessibilityState={{ expanded: openSection === title }}>
                            <Text style={styles.heading}>{title}</Text>
                            <Text style={styles.link}>{openSection === title ? '−' : '+'}</Text>
                          </TouchableOpacity>
                          {openSection === title &&
                            keys.filter((key) => !assessment || (!numericFields.has(key) && key !== 'currency')).map((key) => field(key, data[key], (value) => update(key, value)))}
                        </View>
                      ))}
                      {!assessment && (['repair_items', 'labour_breakdown', 'valuation'] as const).map((key) => (
                        <View key={key} style={styles.panel}>
                          <TouchableOpacity
                            style={styles.sectionButton}
                            onPress={() => setOpenSection(openSection === key ? '' : key)}
                            accessibilityRole="button"
                            accessibilityState={{ expanded: openSection === key }}>
                            <Text style={styles.heading}>{label(key)}</Text>
                            <Text style={styles.link}>{openSection === key ? '−' : '+'}</Text>
                          </TouchableOpacity>
                          {openSection === key &&
                            (key === 'repair_items'
                              ? rowFields(key, [
                                  'name',
                                  'sku',
                                  'quantity',
                                  'unit_price',
                                  'vendor',
                                  'notes',
                                ])
                              : key === 'labour_breakdown'
                                ? rowFields(key, ['task', 'hours', 'rate_per_hour', 'notes'])
                                : Object.entries(data.valuation || {})
                                    .filter(
                                      ([name, value]) =>
                                        !/link|url|evidence|source/i.test(name) &&
                                        ['string', 'number'].includes(typeof value)
                                    )
                                    .map(([name, value]) =>
                                      field(
                                        name,
                                        value,
                                        (next) =>
                                          update('valuation', { ...data.valuation, [name]: next }),
                                        'Valuation '
                                      )
                                    ))}
                        </View>
                      ))}
                    </>
                  )}
                  <View style={styles.panel}>
                    <Text style={styles.heading}>Report files</Text>
                    <Text style={styles.muted}>
                      {readOnly
                        ? 'Return to Assigned Approvals after reviewing. File downloads follow the existing approval and release policy.'
                        : report.downloadable
                          ? 'Approved and released files'
                          : report.files_ready
                            ? 'Files are prepared. Downloads remain subject to approval and release.'
                            : 'Submit the reviewed preview to generate PDF, DOCX, Excel and image files.'}
                    </Text>
                    {report.downloadable &&
                      Object.entries(report.files || {}).map(
                        ([key, id]) =>
                          id && (
                            <TouchableOpacity
                              key={key}
                              style={styles.smallButton}
                              disabled={!!downloadKey}
                              onPress={() => {
                                void download(key, id);
                              }}>
                              <Text style={styles.link}>
                                {downloadKey === key
                                  ? 'Downloading…'
                                  : `Download ${key.toUpperCase()}`}
                              </Text>
                            </TouchableOpacity>
                          )
                      )}
                  </View>
                </>
              )}
            </>
          )}
        </ScrollView>
      )}
      {!readOnly &&
        previewOpen &&
        report &&
        !generating &&
        Object.keys(data).length > 0 &&
        (report.status !== 'error' || report.preview_available === true) && (
          <View style={styles.footer}>
            <TouchableOpacity
              style={styles.secondary}
              disabled={!editable || !dirty}
              onPress={() => {
                void handleSave(false);
              }}>
              <Text style={styles.link}>{busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.primary, !editable && styles.disabled]}
              disabled={!editable}
              onPress={() => {
                void handleSave(true);
              }}>
              <Text style={styles.primaryText}>
                {busy
                  ? 'Please wait…'
                  : salvageSubmissionAction(report) === 'resubmit'
                    ? 'Save & resubmit'
                    : 'Save & submit'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
    </SafeAreaView>
  );
}

const createStyles = (c: AppThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 8,
    },
    title: { fontSize: 18, fontWeight: '700', color: c.text },
    heading: { fontSize: 16, fontWeight: '600', color: c.text },
    muted: { color: c.textSecondary, fontSize: 13, lineHeight: 19 },
    content: { padding: 12, gap: 12, width: '100%', maxWidth: 1000, alignSelf: 'center' },
    loading: { margin: 40 },
    panel: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 12,
      gap: 10,
    },
    sectionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: 36,
    },
    field: { marginTop: 8 },
    label: { color: c.textSecondary, fontSize: 13, marginBottom: 5 },
    input: {
      color: c.text,
      backgroundColor: c.surfaceRaised,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 6,
      minHeight: 44,
      padding: 10,
      textAlignVertical: 'top',
    },
    warning: { backgroundColor: c.warningSoft, color: c.text, padding: 12, borderRadius: 6 },
    danger: { color: c.danger },
    link: { color: c.accent, fontWeight: '600' },
    smallButton: { minHeight: 44, padding: 10, justifyContent: 'center' },
    rowCard: {
      padding: 10,
      marginVertical: 6,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
    },
    photos: { flexGrow: 0 },
    photo: { width: 100, height: 90, borderRadius: 6, marginRight: 6 },
    footer: {
      flexDirection: 'row',
      gap: 8,
      padding: 12,
      borderTopWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    secondary: {
      flex: 1,
      minHeight: 48,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 6,
    },
    primary: {
      flex: 1,
      minHeight: 48,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: 6,
      backgroundColor: c.accent,
    },
    primaryText: { color: c.accentText, fontWeight: '700' },
    disabled: { opacity: 0.5 },
  });
