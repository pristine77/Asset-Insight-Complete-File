import React, { useRef, useState } from 'react';
import { Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from '../context/ThemeContext';

const ACCOUNT_LINKS = [
  { label: 'Privacy policy', url: 'https://assetinsightvaluator.com/privacy' },
  { label: 'Account deletion', url: 'https://assetinsightvaluator.com/account-deletion' },
] as const;

/** Public instructions only. Opening these links never deletes account or device data. */
export default function AccountPrivacyLinks() {
  const { colors } = useAppTheme();
  const openingRef = useRef(false);
  const [opening, setOpening] = useState<string | null>(null);

  const openLink = async (link: (typeof ACCOUNT_LINKS)[number]) => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(link.label);
    try {
      await Linking.openURL(link.url);
    } catch {
      Alert.alert(
        `Could not open ${link.label.toLowerCase()}`,
        `Try again, or open ${link.url} in your browser. Your account and saved work are unchanged.`,
      );
    } finally {
      openingRef.current = false;
      setOpening(null);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.links}>
        {ACCOUNT_LINKS.map((link) => (
          <TouchableOpacity
            key={link.url}
            accessibilityRole="link"
            accessibilityLabel={link.label}
            accessibilityHint="Opens the Asset Insight website in your browser"
            accessibilityState={{ disabled: opening !== null, busy: opening === link.label }}
            disabled={opening !== null}
            onPress={() => void openLink(link)}
            style={styles.link}
          >
            <Text style={[styles.label, { color: colors.accent }]}>{link.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={[styles.note, { color: colors.textSecondary }]}>
        Read how your data is used or request account deletion. Opens in your browser.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 12 },
  links: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: 8 },
  link: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 12 },
  label: { fontSize: 13, fontWeight: '600', textDecorationLine: 'underline', textAlign: 'center' },
  note: { fontSize: 12, lineHeight: 18, textAlign: 'center', paddingHorizontal: 8 },
});
