import React, { memo, useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from '../context/ThemeContext';

export type LotPhotoCount = { id: string; lotNumber?: string; title?: string; images: number; extraImages: number; missingImages: number };
const PAGE_SIZE = 10;

export default memo(function LotPhotoCounts({ lots }: { lots: LotPhotoCount[] }) {
  const { colors } = useAppTheme();
  const [expanded, setExpanded] = useState(true);
  const [page, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(lots.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  useEffect(() => { setPage(current => Math.min(current, lastPage)); }, [lastPage]);
  const start = currentPage * PAGE_SIZE;
  return <View style={styles.section}>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Photos by lot" accessibilityState={{ expanded }}
      onPress={() => setExpanded(value => !value)} style={styles.button}>
      <Text style={[styles.heading, { color: colors.text }]}>{expanded ? '▾' : '▸'} Photos by lot · {lots.length}</Text>
    </TouchableOpacity>
    {expanded ? <>
      {!lots.length ? <Text style={{ color: colors.textSecondary }}>No lots yet.</Text> : null}
      {lots.slice(start, start + PAGE_SIZE).map((lot, index) => <View key={lot.id} style={[styles.lot, { borderColor: colors.border }]}>
        <Text style={{ color: colors.text }}>Lot {lot.lotNumber?.trim() || start + index + 1} · {lot.images} {lot.images === 1 ? 'image' : 'images'}</Text>
        {lot.title ? <Text style={{ color: colors.textSecondary }}>{lot.title}</Text> : null}
        {lot.extraImages > 0 ? <Text style={{ color: colors.textSecondary }}>{lot.images - lot.extraImages} main · {lot.extraImages} report-only</Text> : null}
        {lot.missingImages > 0 ? <Text style={{ color: colors.danger }}>{lot.missingImages} missing — original files need attention</Text> : null}
      </View>)}
      {lots.length > PAGE_SIZE ? <View style={styles.pager}>
        <Text style={{ color: colors.textSecondary }}>Lots {start + 1}–{Math.min(start + PAGE_SIZE, lots.length)} of {lots.length}</Text>
        <View style={styles.actions}>
          <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: currentPage === 0 }} disabled={currentPage === 0}
            onPress={() => setPage(currentPage - 1)} style={styles.button}><Text style={{ color: currentPage === 0 ? colors.textSecondary : colors.accent }}>Previous lots</Text></TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: currentPage === lastPage }} disabled={currentPage === lastPage}
            onPress={() => setPage(currentPage + 1)} style={styles.button}><Text style={{ color: currentPage === lastPage ? colors.textSecondary : colors.accent }}>Next lots</Text></TouchableOpacity>
        </View>
      </View> : null}
    </> : null}
  </View>;
});

const styles = StyleSheet.create({ section: { gap: 4 }, heading: { fontSize: 15, fontWeight: '600' },
  button: { minHeight: 44, paddingVertical: 10, paddingHorizontal: 8, justifyContent: 'center', flexShrink: 1 },
  lot: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 8, gap: 3 },
  pager: { gap: 4, paddingTop: 6 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } });
