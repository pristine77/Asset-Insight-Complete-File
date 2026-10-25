import React, { useEffect, useMemo, useState } from 'react';
import {
  Image,
  ImageBackground,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useAppTheme, type AppThemeColors } from '../context/ThemeContext';

// The app icon's wordmark cropped tight (862 x 294, transparent): the square
// icon squeezed into this plate showed the words about 10 points tall.
const BrandWordmark = require('../../assets/asset-insight-wordmark.png');
const EquipmentArtwork = require('../../assets/auth-equipment-yard.png');

interface CrmEntryScreenProps {
  onSelectListings: () => void;
  onSelectCrm: () => void;
}

const CrmEntryScreen = ({ onSelectListings, onSelectCrm }: CrmEntryScreenProps) => {
  const { width, height, fontScale } = useWindowDimensions();
  const isTablet = width >= 700;
  const compactHeight = height < 720;
  const { isDark, colors, toggleTheme } = useAppTheme();
  const styles = useMemo(
    () => createStyles(colors, isTablet, compactHeight),
    [colors, compactHeight, isTablet]
  );

  // A short screen with a large text size (e.g. 360 x 640 at 130%) can still
  // overflow. Measure, and only then drop the two helper lines, so the cards
  // stay on one page; every other phone keeps them. Re-checked when the window
  // or text size changes, and when the visible area changes (the upload bar
  // appearing or going away).
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [condensed, setCondensed] = useState(false);
  useEffect(() => setCondensed(false), [width, height, fontScale, viewportHeight]);
  useEffect(() => {
    if (!condensed && viewportHeight > 0 && contentHeight > viewportHeight + 1) setCondensed(true);
  }, [condensed, contentHeight, viewportHeight]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'right', 'bottom', 'left']}>
      <ScrollView
        testID="workspace-scroll"
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        bounces={false}
        onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
        onContentSizeChange={(_contentWidth, nextHeight) => setContentHeight(nextHeight)}>
        <ImageBackground source={EquipmentArtwork} style={styles.hero} imageStyle={styles.heroImage}>
          <View style={styles.heroTopRow}>
            <View style={styles.logoPlate}>
              <Image source={BrandWordmark} style={styles.logo} resizeMode="contain" accessibilityLabel="Asset Insight" />
            </View>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={isDark ? 'Use light theme' : 'Use dark theme'} onPress={toggleTheme} style={styles.themeButton} activeOpacity={0.75}>
              <Feather name={isDark ? 'sun' : 'moon'} size={18} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
          <View style={styles.heroCopy}>
            {/* One line, shrinking a little at large text sizes, so the page still fits. */}
            <Text style={styles.heroTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
              Choose your workspace
            </Text>
            {condensed ? null : (
              <Text style={styles.heroSubtitle}>Continue to appraisals or manage customer follow-up.</Text>
            )}
          </View>
        </ImageBackground>

        <View style={styles.workspaceSection}>
          <Text style={styles.sectionTitle}>Where are you working?</Text>
          {condensed ? (
            <View style={styles.sectionSpacer} />
          ) : (
            <Text style={styles.sectionSubtitle}>Your selection can be changed later from the side menu.</Text>
          )}

          <View style={styles.workspaceGrid}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open Listings workspace" style={styles.workspaceCard} onPress={onSelectListings} activeOpacity={0.76}>
              <View style={[styles.workspaceIcon, { backgroundColor: colors.accentSoft }]}>
                <Feather name="briefcase" size={24} color={colors.accent} />
              </View>
              <View style={styles.workspaceCopy}>
                <Text style={styles.workspaceTitle}>Listings</Text>
                <Text style={styles.workspaceDescription}>
                  Create Asset, Lot Listing, Real Estate, and Salvage reports.
                </Text>
                <View style={styles.featureRow}>
                  <Feather name="check" size={13} color={colors.success} />
                  <Text style={styles.featureText}>Reports, previews, files</Text>
                </View>
              </View>
              <View style={[styles.workspaceArrow, { backgroundColor: colors.accent }]}>
                <Feather name="arrow-right" size={17} color="#FFFFFF" />
              </View>
            </TouchableOpacity>

            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open CRM workspace" style={styles.workspaceCard} onPress={onSelectCrm} activeOpacity={0.76}>
              <View style={[styles.workspaceIcon, { backgroundColor: colors.infoSoft }]}>
                <Feather name="headphones" size={24} color={colors.info} />
              </View>
              <View style={styles.workspaceCopy}>
                <Text style={styles.workspaceTitle}>CRM</Text>
                <Text style={styles.workspaceDescription}>
                  Manage leads, tasks, calls, and scheduled customer follow-up.
                </Text>
                <View style={styles.featureRow}>
                  <Feather name="check" size={13} color={colors.success} />
                  <Text style={styles.featureText}>Leads, calendar, activity</Text>
                </View>
              </View>
              <View style={[styles.workspaceArrow, { backgroundColor: colors.info }]}>
                <Feather name="arrow-right" size={17} color="#FFFFFF" />
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

/*
 * One page, no scrolling on most phones (owner 2026-10-11): the workspace
 * cards keep their natural height and the photo header takes whatever height
 * is left, down to a floor that still shows the logo and title. Only a very
 * short screen or a very large text size scrolls, and then nothing is cut off.
 */
const createStyles = (colors: AppThemeColors, isTablet: boolean, compactHeight: boolean) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scrollContent: { flexGrow: 1, maxWidth: 920, width: '100%', alignSelf: 'center' },
    hero: {
      flexGrow: 1,
      minHeight: isTablet ? 360 : compactHeight ? 170 : 190,
      paddingHorizontal: isTablet ? 28 : 16,
      paddingVertical: 16,
      justifyContent: 'space-between',
      backgroundColor: colors.graphite,
    },
    heroImage: { resizeMode: 'cover' },
    heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    logoPlate: { borderRadius: 10, paddingHorizontal: 11, paddingVertical: 6, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', shadowColor: '#000000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 4 },
    logo: { width: 120, height: 41 },
    themeButton: { width: 44, height: 44, borderRadius: 9, backgroundColor: 'rgba(9,12,18,0.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
    heroCopy: { maxWidth: 560, marginTop: 12, backgroundColor: 'rgba(9,12,18,0.82)', borderLeftWidth: 4, borderLeftColor: colors.accent, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 8 },
    heroTitle: { color: '#FFFFFF', fontSize: isTablet ? 30 : 23, fontWeight: '900' },
    heroSubtitle: { color: '#D5DAE3', fontSize: 12.5, lineHeight: 18, marginTop: 4 },
    workspaceSection: { paddingHorizontal: isTablet ? 28 : 16, paddingVertical: isTablet ? 24 : 16 },
    sectionTitle: { color: colors.text, fontSize: 20, fontWeight: '900' },
    sectionSubtitle: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 4, marginBottom: 12 },
    sectionSpacer: { height: 10 },
    workspaceGrid: { flexDirection: isTablet ? 'row' : 'column', gap: 10 },
    // Phones: as tall as the text needs; tablets keep the side-by-side cards' height.
    workspaceCard: { flex: isTablet ? 1 : undefined, minHeight: isTablet ? 150 : undefined, borderRadius: 11, borderWidth: 1, borderColor: colors.border, borderBottomWidth: 4, borderBottomColor: colors.borderStrong, backgroundColor: colors.surfaceRaised, paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', shadowColor: colors.shadow, shadowOffset: { width: 0, height: 7 }, shadowOpacity: 0.12, shadowRadius: 11, elevation: 5 },
    workspaceIcon: { width: 50, height: 50, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
    workspaceCopy: { flex: 1, minWidth: 0 },
    workspaceTitle: { color: colors.text, fontSize: 17, fontWeight: '900' },
    workspaceDescription: { color: colors.textSecondary, fontSize: 11.5, lineHeight: 16, marginTop: 4 },
    featureRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 7 },
    featureText: { color: colors.textMuted, fontSize: 10.5, fontWeight: '700', flexShrink: 1 },
    workspaceArrow: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  });

export default CrmEntryScreen;
