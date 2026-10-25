import React, { useMemo } from 'react';
import {
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useAppTheme, type AppThemeColors } from '../context/ThemeContext';

// The wordmark cropped tight with a transparent background (862 x 294). The old
// square logo on black showed as a small black box with unreadable text.
const BrandWordmark = require('../../assets/asset-insight-wordmark.png');

export type ScreenName =
  | 'dashboard'
  | 'auctionManagement'
  | 'savedInputs'
  | 'offlineReports'
  | 'profile'
  | 'support'
  | 'reports'
  | 'approvals'
  | 'releases'
  | 'preview'
  | 'crmEntry'
  | 'crmDashboard'
  | 'crmTasks'
  | 'crmCalendar'
  | 'crmOutlookCalendar';

type CrmMode = 'listing' | 'crm';

interface DrawerContentProps {
  onClose: () => void;
  onNavigate: (screen: ScreenName) => void;
  activeScreen: ScreenName;
  crmMode?: CrmMode;
  onSwitchToCrm?: () => void;
  onSwitchToListing?: () => void;
}

type NavigationItem = {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  screen?: ScreenName;
  action?: () => void;
  active?: boolean;
};

function NavigationRow({
  item,
  accent,
  colors,
  styles,
}: {
  item: NavigationItem;
  accent: string;
  colors: AppThemeColors;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: Boolean(item.active) }}
      onPress={item.action}
      activeOpacity={0.72}
      style={[styles.navRow, item.active && styles.navRowActive]}>
      <View style={[styles.navIcon, item.active && { backgroundColor: accent }]}>
        <Feather name={item.icon} size={17} color={item.active ? '#FFFFFF' : colors.textSecondary} />
      </View>
      <Text style={[styles.navLabel, item.active && { color: accent }]} numberOfLines={1}>
        {item.label}
      </Text>
      <Feather name="chevron-right" size={14} color={item.active ? accent : colors.textMuted} />
    </TouchableOpacity>
  );
}

const DrawerContent = ({
  onClose,
  onNavigate,
  activeScreen,
  crmMode = 'listing',
  onSwitchToCrm,
  onSwitchToListing,
}: DrawerContentProps) => {
  const { user, logout } = useAuth();
  const { colors, isDark, toggleTheme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const isCrmAgent = Boolean(user?.isCrmAgent);
  const isCrmMode = isCrmAgent && crmMode === 'crm';
  const accent = isCrmMode ? '#0284C7' : colors.accent;

  const navigate = (screen: ScreenName) => {
    onNavigate(screen);
    onClose();
  };

  const primaryItems: NavigationItem[] = (() => {
    if (isCrmMode) {
      const crmItems: NavigationItem[] = [
        { icon: 'pie-chart', label: 'CRM Dashboard', screen: 'crmDashboard' },
        { icon: 'check-square', label: 'CRM Tasks', screen: 'crmTasks' },
        // Follow-up dates by day (2026-10-11).
        { icon: 'flag', label: 'CRM Calendar', screen: 'crmCalendar' },
        { icon: 'calendar', label: 'Outlook Calendar', screen: 'crmOutlookCalendar' },
      ];
      return crmItems.map((item) => ({
        ...item,
        active: activeScreen === item.screen,
        action: () => navigate(item.screen as ScreenName),
      }));
    }

    const items: NavigationItem[] = [
      { icon: 'home', label: 'Dashboard', screen: 'dashboard' },
      { icon: 'inbox', label: 'Incoming', screen: 'auctionManagement' },
      { icon: 'file-text', label: 'My Reports', screen: 'reports' },
      { icon: 'eye', label: 'Previews', screen: 'preview' },
      { icon: 'hard-drive', label: 'Drafts', screen: 'offlineReports' },
    ];
    if (user?.isReportApprover) {
      items.splice(4, 0, { icon: 'check-circle', label: 'Approvals', screen: 'approvals' });
    }
    if (user?.isReleaseManager) {
      items.splice(5, 0, { icon: 'unlock', label: 'Releases', screen: 'releases' });
    }
    return items.map((item) => ({
      ...item,
      active:
        activeScreen === item.screen ||
        (item.screen === 'offlineReports' && activeScreen === 'savedInputs'),
      action: () => navigate(item.screen as ScreenName),
    }));
  })();

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          await logout();
          onClose();
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <View style={[styles.brandBar, { paddingTop: Math.max(insets.top, 10) + 4 }]}>
        {/* Dark theme: a white plate keeps the black "ASSET" readable without recolouring the logo. */}
        <View style={isDark ? styles.logoPlateDark : null}>
          <Image source={BrandWordmark} style={styles.logo} resizeMode="contain" accessibilityLabel="Asset Insight" />
        </View>
        <TouchableOpacity onPress={onClose} style={styles.closeButton} activeOpacity={0.72}>
          <Feather name="x" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <View style={styles.accountRow}>
        <View style={[styles.avatar, { backgroundColor: accent }]}>
          <Text style={styles.avatarText}>
            {(user?.username || user?.email || 'U').charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={styles.accountCopy}>
          <Text style={styles.accountName} numberOfLines={1}>
            {user?.username || user?.email?.split('@')[0] || 'User'}
          </Text>
          <Text style={styles.accountEmail} numberOfLines={1}>{user?.email || ''}</Text>
        </View>
      </View>

      <ScrollView
        style={styles.navScroll}
        contentContainerStyle={styles.navContent}
        showsVerticalScrollIndicator={false}>
        <Text style={styles.sectionLabel}>{isCrmMode ? 'CRM WORKSPACE' : 'LISTING WORKSPACE'}</Text>
        <View style={styles.navGroup}>
          {primaryItems.map((item) => (
            <NavigationRow key={item.label} item={item} accent={accent} colors={colors} styles={styles} />
          ))}
        </View>

        {isCrmAgent ? (
          <>
            <Text style={styles.sectionLabel}>WORKSPACE</Text>
            <NavigationRow
              item={{
                icon: isCrmMode ? 'grid' : 'headphones',
                label: isCrmMode ? 'Switch to Listings' : 'Switch to CRM',
                action: () => {
                  if (isCrmMode) onSwitchToListing?.();
                  else onSwitchToCrm?.();
                  onClose();
                },
              }}
              accent={accent}
              colors={colors}
              styles={styles}
            />
          </>
        ) : null}

        <Text style={styles.sectionLabel}>ACCOUNT</Text>
        <NavigationRow
          item={{
            icon: 'help-circle',
            label: 'Help & Support',
            active: activeScreen === 'support',
            action: () => navigate('support'),
          }}
          accent={accent}
          colors={colors}
          styles={styles}
        />
        <NavigationRow
          item={{
            icon: 'user',
            label: 'Profile',
            active: activeScreen === 'profile',
            action: () => navigate('profile'),
          }}
          accent={accent}
          colors={colors}
          styles={styles}
        />
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <TouchableOpacity onPress={toggleTheme} style={styles.footerButton} activeOpacity={0.72}>
          <Feather name={isDark ? 'sun' : 'moon'} size={17} color={colors.textSecondary} />
          <Text style={styles.footerButtonText}>{isDark ? 'Light theme' : 'Dark theme'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleLogout} style={styles.footerButton} activeOpacity={0.72}>
          <Feather name="log-out" size={17} color={colors.danger} />
          <Text style={[styles.footerButtonText, { color: colors.danger }]}>Logout</Text>
        </TouchableOpacity>
        <Text style={styles.version}>Asset Insight v1.0.0</Text>
      </View>
    </SafeAreaView>
  );
};

const createStyles = (colors: AppThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    brandBar: {
      minHeight: 76,
      paddingHorizontal: 16,
      paddingBottom: 10,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    // 862 x 294 wordmark: 132 wide is 45 tall.
    logo: { width: 132, height: 45 },
    logoPlateDark: { backgroundColor: '#FFFFFF', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
    closeButton: {
      width: 36,
      height: 36,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMuted,
      borderWidth: 1,
      borderColor: colors.border,
    },
    accountRow: {
      minHeight: 70,
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    avatar: { width: 40, height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
    avatarText: { color: '#FFFFFF', fontSize: 16, fontWeight: '900' },
    accountCopy: { flex: 1, marginLeft: 10, minWidth: 0 },
    accountName: { color: colors.text, fontSize: 13, fontWeight: '900' },
    accountEmail: { color: colors.textMuted, fontSize: 10.5, marginTop: 2 },
    navScroll: { flex: 1 },
    navContent: { padding: 10, paddingBottom: 18 },
    sectionLabel: {
      color: colors.textMuted,
      fontSize: 9,
      fontWeight: '900',
      marginTop: 14,
      marginBottom: 6,
      paddingHorizontal: 8,
      letterSpacing: 0.8,
    },
    navGroup: { gap: 2 },
    navRow: {
      minHeight: 45,
      borderRadius: 8,
      paddingHorizontal: 8,
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: 'transparent',
    },
    navRowActive: { backgroundColor: colors.accentSoft, borderColor: colors.border },
    navIcon: {
      width: 31,
      height: 31,
      borderRadius: 7,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 8,
    },
    navLabel: { flex: 1, color: colors.textSecondary, fontSize: 12.5, fontWeight: '700' },
    footer: { padding: 10, borderTopWidth: 1, borderTopColor: colors.border, gap: 4 },
    footerButton: {
      height: 42,
      borderRadius: 8,
      paddingHorizontal: 9,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
    },
    footerButtonText: { color: colors.textSecondary, fontSize: 12, fontWeight: '800' },
    version: { color: colors.textMuted, fontSize: 9.5, textAlign: 'center', marginTop: 5 },
  });

export default DrawerContent;
