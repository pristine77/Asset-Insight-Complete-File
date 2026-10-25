import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppTheme, type AppThemeColors } from '../context/ThemeContext';
import api from '../services/api';

interface SavedInput {
  _id: string;
  name: string;
  formType: 'asset' | 'realEstate';
  formData: Record<string, any>;
  isDraft?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SavedInputsScreenProps {
  onOpenDrawer: () => void;
  onBack: () => void;
  onLoadSavedInput?: (savedInput: SavedInput) => void;
}

type SavedInputFilter = 'all' | 'asset' | 'realEstate';

const FILTERS: { key: SavedInputFilter; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { key: 'all', label: 'All', icon: 'layers' },
  { key: 'asset', label: 'Asset', icon: 'package' },
  { key: 'realEstate', label: 'Real estate', icon: 'home' },
];

export default function SavedInputsScreen({
  onOpenDrawer,
  onBack,
  onLoadSavedInput,
}: SavedInputsScreenProps) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [savedInputs, setSavedInputs] = useState<SavedInput[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<SavedInputFilter>('all');

  const fetchSavedInputs = useCallback(async () => {
    try {
      const params = activeFilter === 'all' ? {} : { formType: activeFilter };
      const { data } = await api.get('/saved-inputs', { params });
      setSavedInputs(Array.isArray(data?.data) ? data.data : []);
    } catch (error) {
      console.error('Error fetching saved inputs:', error);
      Alert.alert('Unable to load', 'Saved inputs could not be loaded. Pull down to try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeFilter]);

  useEffect(() => {
    setLoading(true);
    void fetchSavedInputs();
  }, [fetchSavedInputs]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void fetchSavedInputs();
  }, [fetchSavedInputs]);

  const handleDelete = useCallback((id: string, name: string) => {
    Alert.alert('Delete saved input?', `“${name}” will be permanently removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(`/saved-inputs/${id}`);
            setSavedInputs((current) => current.filter((item) => item._id !== id));
          } catch {
            Alert.alert('Delete failed', 'The saved input could not be deleted.');
          }
        },
      },
    ]);
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.surface}
          />
        }>
        <View style={styles.appBar}>
          <TouchableOpacity style={styles.iconButton} onPress={onOpenDrawer} activeOpacity={0.72}>
            <Feather name="menu" size={20} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.titleWrap}>
            <Text style={styles.eyebrow}>LISTING WORKSPACE</Text>
            <Text style={styles.title}>Saved inputs</Text>
          </View>
          <TouchableOpacity style={styles.iconButton} onPress={onBack} activeOpacity={0.72}>
            <Feather name="arrow-left" size={19} color={colors.text} />
          </TouchableOpacity>
        </View>

        <View style={styles.summaryRow}>
          <View>
            <Text style={styles.summaryValue}>{savedInputs.length}</Text>
            <Text style={styles.summaryLabel}>Saved templates</Text>
          </View>
          <View style={styles.summaryIcon}>
            <Feather name="bookmark" size={20} color={colors.accent} />
          </View>
        </View>

        <View style={styles.filters}>
          {FILTERS.map((filter) => {
            const selected = activeFilter === filter.key;
            return (
              <TouchableOpacity
                key={filter.key}
                style={[styles.filterButton, selected && styles.filterButtonSelected]}
                onPress={() => setActiveFilter(filter.key)}
                activeOpacity={0.72}>
                <Feather
                  name={filter.icon}
                  size={14}
                  color={selected ? colors.accentText : colors.textSecondary}
                />
                <Text style={[styles.filterText, selected && styles.filterTextSelected]}>{filter.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {loading ? (
          <View style={styles.loadingState}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.loadingText}>Loading saved inputs...</Text>
          </View>
        ) : savedInputs.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyIcon}>
              <Feather name="bookmark" size={24} color={colors.accent} />
            </View>
            <Text style={styles.emptyTitle}>No saved inputs</Text>
            <Text style={styles.emptyText}>Reusable Asset and Real Estate form details will appear here.</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {savedInputs.map((item) => {
              const isRealEstate = item.formType === 'realEstate';
              const itemColor = isRealEstate ? colors.success : colors.accent;
              return (
                <TouchableOpacity
                  key={item._id}
                  style={styles.card}
                  onPress={() => onLoadSavedInput?.(item)}
                  activeOpacity={0.76}>
                  <View style={[styles.cardAccent, { backgroundColor: itemColor }]} />
                  <View style={[styles.cardIcon, { backgroundColor: isRealEstate ? colors.successSoft : colors.accentSoft }]}>
                    <Feather name={isRealEstate ? 'home' : 'package'} size={19} color={itemColor} />
                  </View>
                  <View style={styles.cardCopy}>
                    <View style={styles.cardMetaRow}>
                      <Text style={[styles.typeLabel, { color: itemColor }]}>
                        {isRealEstate ? 'REAL ESTATE' : 'ASSET'}
                      </Text>
                      {item.isDraft ? <Text style={styles.draftLabel}>DRAFT</Text> : null}
                    </View>
                    <Text style={styles.cardTitle} numberOfLines={2}>{item.name}</Text>
                    <Text style={styles.cardDate}>
                      Updated {new Date(item.updatedAt || item.createdAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.deleteButton}
                    onPress={(event) => {
                      event.stopPropagation();
                      handleDelete(item._id, item.name);
                    }}>
                    <Feather name="trash-2" size={16} color={colors.danger} />
                  </TouchableOpacity>
                  <Feather name="chevron-right" size={18} color={colors.textMuted} />
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: AppThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scrollView: { flex: 1 },
    content: { width: '100%', maxWidth: 920, alignSelf: 'center', padding: 14, paddingBottom: 36 },
    appBar: { minHeight: 58, flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
    iconButton: {
      width: 40,
      height: 40,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    titleWrap: { flex: 1, minWidth: 0, marginHorizontal: 11 },
    eyebrow: { color: colors.accent, fontSize: 8.5, fontWeight: '900', letterSpacing: 1 },
    title: { color: colors.text, fontSize: 21, fontWeight: '900', marginTop: 1 },
    summaryRow: {
      minHeight: 82,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 15,
      paddingVertical: 12,
      marginBottom: 12,
      backgroundColor: colors.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    summaryValue: { color: colors.text, fontSize: 24, fontWeight: '900' },
    summaryLabel: { color: colors.textMuted, fontSize: 10.5, fontWeight: '700', marginTop: 2 },
    summaryIcon: { width: 42, height: 42, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
    filters: { flexDirection: 'row', gap: 6, marginBottom: 14 },
    filterButton: {
      flex: 1,
      minHeight: 40,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingHorizontal: 8,
      borderRadius: 8,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    filterButtonSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
    filterText: { color: colors.textSecondary, fontSize: 10.5, fontWeight: '800' },
    filterTextSelected: { color: colors.accentText },
    loadingState: { minHeight: 170, alignItems: 'center', justifyContent: 'center', gap: 9 },
    loadingText: { color: colors.textMuted, fontSize: 11.5, fontWeight: '700' },
    emptyState: { minHeight: 220, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
    emptyIcon: { width: 50, height: 50, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
    emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '900', marginTop: 12 },
    emptyText: { color: colors.textMuted, fontSize: 11.5, lineHeight: 17, textAlign: 'center', marginTop: 4 },
    list: { gap: 9 },
    card: {
      position: 'relative',
      minHeight: 82,
      overflow: 'hidden',
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingLeft: 12,
      paddingRight: 9,
      backgroundColor: colors.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cardAccent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
    cardIcon: { width: 48, height: 48, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
    cardCopy: { flex: 1, minWidth: 0 },
    cardMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    typeLabel: { fontSize: 7.5, fontWeight: '900', letterSpacing: 0.65 },
    draftLabel: { color: colors.warning, fontSize: 7.5, fontWeight: '900', letterSpacing: 0.5 },
    cardTitle: { color: colors.text, fontSize: 12.5, lineHeight: 16, fontWeight: '900', marginTop: 3 },
    cardDate: { color: colors.textMuted, fontSize: 9.5, fontWeight: '600', marginTop: 3 },
    deleteButton: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.dangerSoft, marginLeft: 8, marginRight: 5 },
  });
