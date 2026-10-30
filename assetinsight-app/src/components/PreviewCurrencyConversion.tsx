import React, { useEffect, useRef, useState } from 'react';
import { Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import api from '../services/api';
import CurrencySelect from './forms/CurrencySelect';
import { getAuthOperationEpoch } from '../services/authSessionOperation';

type Quote = { fromCurrency: string; toCurrency: string; rate: number; asOf: string; sourceUrl: string; sourceTitle: string; quotedAt: string };
type Operation = { generation: number; target: string; authEpoch: number; abort: AbortController };
type AppliedConversion = { preview: Record<string, any>; endpoint: string; authEpoch: number; target: string };

export default function PreviewCurrencyConversion({ previewData, endpoint, disabled, onBusyChange, onPendingChange, onConverted }: {
  previewData: Record<string, any>; endpoint: string; disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onPendingChange: (target: string | null) => void;
  onConverted: (preview: Record<string, any>) => void;
}) {
  const source = String(previewData.currency || 'CAD').toUpperCase();
  const authEpoch = getAuthOperationEpoch();
  const context = useRef({ endpoint, source, authEpoch, generation: 0, scope: 0 });
  if (context.current.endpoint !== endpoint || context.current.source !== source || context.current.authEpoch !== authEpoch) {
    const previous = context.current;
    context.current = {
      endpoint, source, authEpoch, generation: previous.generation + 1,
      scope: previous.scope + (previous.endpoint !== endpoint || previous.authEpoch !== authEpoch ? 1 : 0),
    };
  }
  const generation = context.current.generation;
  const [selection, setSelection] = useState({ generation, target: source });
  const target = selection.generation === generation ? selection.target : source;
  const pending = target !== source;
  const [busyGeneration, setBusyGeneration] = useState<number | null>(null);
  const busy = busyGeneration === generation;
  const [completed, setCompleted] = useState<{ scope: number; quote: Quote } | null>(null);
  const quote = completed?.scope === context.current.scope && completed.quote.toCurrency === source ? completed.quote : null;
  const current = useRef({ previewData, endpoint, source, disabled });
  current.current = { previewData, endpoint, source, disabled };
  const alive = useRef(true), operation = useRef<Operation | null>(null), applied = useRef<AppliedConversion | null>(null);
  const callbacks = useRef({ onBusyChange, onPendingChange, onConverted });
  callbacks.current = { onBusyChange, onPendingChange, onConverted };
  const observedGeneration = useRef(generation);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      operation.current?.abort.abort();
      operation.current = null;
      callbacks.current.onBusyChange(false);
      callbacks.current.onPendingChange(null);
    };
  }, []);
  useEffect(() => {
    const acknowledged = applied.current && applied.current.preview === previewData &&
      applied.current.endpoint === endpoint && applied.current.authEpoch === authEpoch && applied.current.target === source;
    if (acknowledged || observedGeneration.current !== generation) {
      operation.current?.abort.abort();
      operation.current = null;
      applied.current = null;
      observedGeneration.current = generation;
      setBusyGeneration(null);
      setSelection({ generation, target: source });
      callbacks.current.onBusyChange(false);
      callbacks.current.onPendingChange(null);
    }
  }, [generation, previewData, endpoint, authEpoch, source]);

  const convert = async (requestedTarget: string) => {
    const latest = current.current;
    if (latest.disabled || operation.current || latest.source === requestedTarget) return;
    const snapshot = latest.previewData, from = latest.source, contextEndpoint = latest.endpoint;
    const request: Operation = { generation: context.current.generation, target: requestedTarget, authEpoch: getAuthOperationEpoch(), abort: new AbortController() };
    operation.current = request;
    setBusyGeneration(request.generation);
    callbacks.current.onBusyChange(true);
    const isCurrent = () => alive.current && operation.current === request && !request.abort.signal.aborted &&
      context.current.generation === request.generation && getAuthOperationEpoch() === request.authEpoch;
    try {
      const response = await api.post(contextEndpoint, { targetCurrency: requestedTarget, preview_data: snapshot }, { timeout: 60_000, signal: request.abort.signal, skipAuthRefreshReplay: true });
      if (!isCurrent()) return;
      if (current.current.previewData !== snapshot || current.current.source !== from) {
        Alert.alert('Preview changed', 'Your newer edits were kept. Convert again when you are ready.');
        return;
      }
      const result = response.data?.data;
      if (!result?.preview_data || result.preview_data.currency !== requestedTarget || !result.preview_data.currency_conversion || typeof result.preview_data.currency_conversion !== 'object' || !result?.quote || result.quote.fromCurrency !== from || result.quote.toCurrency !== requestedTarget || !Number.isFinite(result.quote.rate) || result.quote.rate <= 0) throw new Error('A confirmed conversion was not returned. Your report was not changed.');
      applied.current = { preview: result.preview_data, endpoint: contextEndpoint, authEpoch: request.authEpoch, target: requestedTarget };
      setCompleted({ scope: context.current.scope, quote: result.quote });
      callbacks.current.onConverted(result.preview_data);
      // Save stays blocked until the parent renders this exact returned snapshot.
    } catch (error: any) {
      if (isCurrent()) Alert.alert('Currency conversion unavailable', error?.response?.status === 409 ? 'The saved report changed. Reload the preview, review your edits, then try again.' : error?.response?.data?.message || error?.message || 'Your values are unchanged. Please try again.');
    } finally {
      if (alive.current && operation.current === request) {
        operation.current = null;
        setBusyGeneration(null);
        callbacks.current.onBusyChange(false);
      }
    }
  };

  const selectTarget = (next: string) => {
    if (current.current.disabled && !operation.current) return;
    operation.current?.abort.abort();
    operation.current = null;
    applied.current = null;
    setBusyGeneration(null);
    callbacks.current.onBusyChange(false);
    setSelection({ generation: context.current.generation, target: next });
    callbacks.current.onPendingChange(next === current.current.source ? null : next);
    if (next !== current.current.source) void convert(next);
  };
  return <View style={styles.panel}>
    <Text style={styles.heading}>Report currency · {source}</Text>
    <Text style={styles.help}>Choosing a currency converts amounts using a current sourced exchange rate. Photos are not re-analyzed. Existing valuation percentages and fee rules still apply. Save afterward to update the report files.</Text>
    <CurrencySelect value={target} onChange={selectTarget} disabled={disabled || busy} label="Preview target currency" />
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Convert report currency" disabled={disabled || busy || !pending} onPress={() => void convert(target)} style={[styles.button, (disabled || busy || !pending) && styles.disabled]}><Text style={styles.buttonText}>{busy ? 'Converting amounts…' : 'Retry conversion'}</Text></TouchableOpacity>
    {pending ? <Text accessibilityRole="alert" style={styles.help}>{busy ? `Converting ${source} amounts to ${target}. Save is unavailable until conversion is applied.` : `${target} is selected, but the report is still ${source}. Retry conversion before saving, or select ${source} to keep the current amounts.`}</Text> : null}
    {quote ? <View><Text style={styles.help}>1 {quote.fromCurrency} = {quote.rate} {quote.toCurrency} · {quote.asOf}</Text><TouchableOpacity accessibilityRole="link" onPress={() => { if (/^https:\/\//i.test(quote.sourceUrl)) void Linking.openURL(quote.sourceUrl); }}><Text style={styles.link}>{quote.sourceTitle}</Text></TouchableOpacity></View> : null}
  </View>;
}
const styles = StyleSheet.create({ panel: { borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 10, padding: 14, gap: 10, marginBottom: 16, backgroundColor: '#F8FAFC' }, heading: { color: '#111827', fontSize: 16, fontWeight: '700' }, help: { color: '#4B5563', fontSize: 13, lineHeight: 19 }, button: { minHeight: 44, backgroundColor: '#2563EB', justifyContent: 'center', alignItems: 'center', borderRadius: 8, padding: 10 }, disabled: { opacity: .45 }, buttonText: { color: '#FFF', fontSize: 14, fontWeight: '600' }, link: { color: '#2563EB', fontSize: 13, marginTop: 4 } });
