import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme, type AppThemeColors } from '../../context/ThemeContext';
import type { SalvageReportEnrichment as ReportEnrichment } from '../../types/salvageReportEnrichment';

interface Props {
  enrichment?: ReportEnrichment;
  dirty?: boolean;
}

/** Only mount expanded tables: long evidence registers must not slow preview editing. */
export default function SalvageReportEnrichment({ enrichment, dirty = false }: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [openId, setOpenId] = useState('executive-summary');
  if (enrichment?.schemaVersion !== 1 || !enrichment.sections.length) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Saved report review</Text>
      <Text style={styles.muted}>
        {dirty
          ? 'Unsaved edits are not reflected below. Save to refresh the report review.'
          : 'Read-only report content from the saved assessment. Appraiser notes are identified separately from verified evidence.'}
      </Text>
      {enrichment.sections.map((section) => {
        const open = openId === section.id;
        return (
          <View key={section.id} style={styles.section}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={section.title}
              accessibilityState={{ expanded: open }}
              onPress={() => setOpenId(open ? '' : section.id)}
              style={styles.sectionButton}>
              <Text style={styles.heading}>{section.title}</Text>
              <Text style={styles.toggle}>{open ? '−' : '+'}</Text>
            </TouchableOpacity>
            {open ? (
              <View style={styles.content}>
                {section.paragraphs.map((paragraph, index) => (
                  <Text selectable key={index} style={styles.text}>
                    {paragraph}
                  </Text>
                ))}
                {section.tables.map((table, tableIndex) =>
                  table.headers.length ? (
                    <View key={tableIndex} style={styles.tableContainer}>
                      <Text style={styles.muted}>Swipe across to read all columns.</Text>
                      <ScrollView
                        horizontal
                        nestedScrollEnabled
                        showsHorizontalScrollIndicator
                        accessibilityLabel={`${section.title}, table ${tableIndex + 1}`}
                        style={styles.tableScroll}>
                        <View>
                          <View style={[styles.tableRow, styles.tableHeader]}>
                            {table.headers.map((header, index) => (
                              <Text key={index} style={[styles.cell, styles.headerText]}>
                                {header}
                              </Text>
                            ))}
                          </View>
                          {table.rows.map((row, rowIndex) => (
                            <View
                              key={rowIndex}
                              style={[styles.tableRow, rowIndex % 2 === 1 && styles.alternateRow]}>
                              {table.headers.map((header, index) => (
                                <Text
                                  selectable
                                  key={index}
                                  style={styles.cell}
                                  accessibilityLabel={`${header}: ${row[index] ?? ''}`}>
                                  {row[index] ?? ''}
                                </Text>
                              ))}
                            </View>
                          ))}
                        </View>
                      </ScrollView>
                    </View>
                  ) : null
                )}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const createStyles = (c: AppThemeColors) =>
  StyleSheet.create({
    container: { gap: 8, minWidth: 0, maxWidth: '100%' },
    title: { color: c.text, fontSize: 18, fontWeight: '700' },
    muted: { color: c.textSecondary, fontSize: 12, lineHeight: 18 },
    section: {
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 8,
      backgroundColor: c.surface,
      overflow: 'hidden',
    },
    sectionButton: {
      minHeight: 48,
      paddingHorizontal: 12,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    heading: { flex: 1, color: c.text, fontSize: 15, fontWeight: '600', lineHeight: 21 },
    toggle: { color: c.accent, fontSize: 20 },
    content: { gap: 12, padding: 12, paddingTop: 0, minWidth: 0 },
    text: { color: c.text, fontSize: 14, lineHeight: 21 },
    tableContainer: { gap: 4, maxWidth: '100%' },
    tableScroll: { borderWidth: 1, borderColor: c.border, borderRadius: 4 },
    tableRow: {
      flexDirection: 'row',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    tableHeader: { backgroundColor: c.background },
    alternateRow: { backgroundColor: c.background },
    cell: { width: 180, padding: 9, color: c.text, fontSize: 13, lineHeight: 19, flexShrink: 0 },
    headerText: { fontWeight: '700' },
  });
