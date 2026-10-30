import React, { useEffect, useRef, useState } from 'react';
import { Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import api from '../services/api';
import CurrencySelect from './forms/CurrencySelect';
import { getAuthOperationEpoch } from '../services/authSessionOperation';

type Quote = { fromCurrency: string; toCurrency: string; rate: number; asOf: string; sourceUrl: string; sourceTitle: string; quotedAt: string };
export default function PreviewCurrencyConversion({ previewData, endpoint, disabled, onBusyChange, onConverted }: {
  previewData: Record<string, any>; endpoint: string; disabled: boolean;
  onBusyChange: (busy: boolean) => void; onConverted: (preview: Record<string, any>) => void;
}) {
  const source = String(previewData.currency || 'CAD').toUpperCase();
  const [target, setTarget] = useState(source);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const current = useRef({ previewData, endpoint, source }); current.current = { previewData, endpoint, source };
  const alive = useRef(true), inFlight = useRef(false), controller = useRef<AbortController | null>(null);
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); busyCallback.current(false); }; }, []);
  useEffect(() => { setTarget(source); }, [source]);
  const convert = async () => {
    if (disabled || inFlight.current || source === target) return;
    const snapshot = previewData, context = endpoint, from = source, authEpoch = getAuthOperationEpoch();
    inFlight.current = true; setBusy(true); onBusyChange(true);
    const abort = new AbortController(); controller.current = abort;
    try {
      const response = await api.post(endpoint, { targetCurrency: target, preview_data: snapshot }, { timeout: 60_000, signal: abort.signal, skipAuthRefreshReplay: true });
      if (!alive.current || abort.signal.aborted || current.current.endpoint !== context || getAuthOperationEpoch() !== authEpoch) return;
      if (current.current.previewData !== snapshot || current.current.source !== from) {
        Alert.alert('Preview changed', 'Your newer edits were kept. Convert again when you are ready.');
        return;
      }
      const result = response.data?.data;
      if (!result?.preview_data || result.preview_data.currency !== target || !result.preview_data.currency_conversion || typeof result.preview_data.currency_conversion !== 'object' || !result?.quote || result.quote.fromCurrency !== from || result.quote.toCurrency !== target || !Number.isFinite(result.quote.rate) || result.quote.rate <= 0) throw new Error('A confirmed conversion was not returned. Your report was not changed.');
      onConverted(result.preview_data);
      setQuote(result.quote);
    } catch (error: any) {
      if (alive.current && !abort.signal.aborted && getAuthOperationEpoch() === authEpoch) Alert.alert('Currency conversion unavailable', error?.response?.status === 409 ? 'The saved report changed. Reload the preview, review your edits, then try again.' : error?.response?.data?.message || error?.message || 'Your values are unchanged. Please try again.');
    } finally {
      if (alive.current && controller.current === abort) { inFlight.current = false; controller.current = null; setBusy(false); onBusyChange(false); }
    }
  };
  return <View style={styles.panel}>
    <Text style={styles.heading}>Report currency · {source}</Text>
    <Text style={styles.help}>Convert amounts using a current sourced exchange rate. Photos are not re-analyzed. Existing valuation percentages and fee rules still apply. Save afterward to update the report files.</Text>
    <CurrencySelect value={target} onChange={setTarget} disabled={disabled || busy} label="Preview target currency" />
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Convert report currency" disabled={disabled || busy || source === target} onPress={() => void convert()} style={[styles.button, (disabled || busy || source === target) && styles.disabled]}><Text style={styles.buttonText}>{busy ? 'Converting amounts…' : 'Convert amounts'}</Text></TouchableOpacity>
    {quote ? <View><Text style={styles.help}>1 {quote.fromCurrency} = {quote.rate} {quote.toCurrency} · {quote.asOf}</Text><TouchableOpacity accessibilityRole="link" onPress={() => { if (/^https:\/\//i.test(quote.sourceUrl)) void Linking.openURL(quote.sourceUrl); }}><Text style={styles.link}>{quote.sourceTitle}</Text></TouchableOpacity></View> : null}
  </View>;
}
const styles = StyleSheet.create({ panel: { borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 10, padding: 14, gap: 10, marginBottom: 16, backgroundColor: '#F8FAFC' }, heading: { color: '#111827', fontSize: 16, fontWeight: '700' }, help: { color: '#4B5563', fontSize: 13, lineHeight: 19 }, button: { minHeight: 44, backgroundColor: '#2563EB', justifyContent: 'center', alignItems: 'center', borderRadius: 8, padding: 10 }, disabled: { opacity: .45 }, buttonText: { color: '#FFF', fontSize: 14, fontWeight: '600' }, link: { color: '#2563EB', fontSize: 13, marginTop: 4 } });
