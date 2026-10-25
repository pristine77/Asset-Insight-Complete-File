import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useAppTheme, type AppThemeColors } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import AuctioneerIncoming from '../components/auction/AuctioneerIncoming';
import type { AuctioneerReportType } from '../services/auctioneerService';

interface AuctionManagementScreenProps {
  onOpenDrawer: () => void;
  onOpenReport: (reportId: string, reportType: AuctioneerReportType) => void;
}

/** Incoming uses the assigned Auctioneer API, never the retired Auctionsoft proxy. */
export default function AuctionManagementScreen({
  onOpenDrawer,
  onOpenReport,
}: AuctionManagementScreenProps) {
  const { colors } = useAppTheme();
  const { user } = useAuth();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const owner = user?._id || (user as { id?: string } | null)?.id || '';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel="Open menu"
          onPress={onOpenDrawer}>
          <Feather name="menu" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text style={styles.eyebrow}>AUCTIONEER WORKSPACE</Text>
          <Text style={styles.title}>Incoming</Text>
        </View>
        <TouchableOpacity
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel="Refresh incoming contracts"
          onPress={() => setRefreshVersion((value) => value + 1)}>
          <Feather name="refresh-cw" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>
      <AuctioneerIncoming key={owner} refreshVersion={refreshVersion} onOpenReport={onOpenReport} />
    </SafeAreaView>
  );
}

const createStyles = (colors: AppThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
    headerText: { flex: 1, minWidth: 0 },
    eyebrow: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
    title: { fontSize: 24, fontWeight: '700', color: colors.text },
    iconButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      backgroundColor: colors.surface,
    },
  });
