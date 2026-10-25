import React from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import KeyboardSafeViewport from '../KeyboardSafeViewport';

interface Props {
  children: React.ReactNode;
  label: string;
  cardStyle?: StyleProp<ViewStyle>;
  onClose?: () => void;
}
/** Stable, bounded CRM dialog: header, fields and actions all remain scroll-reachable. */
export default function CrmModalFrame({ children, label, cardStyle, onClose }: Props) {
  return (
    <KeyboardSafeViewport style={styles.overlay} testID="crm-modal-viewport">
      <SafeAreaView
        testID="crm-modal-safe-area"
        edges={['top', 'right', 'bottom', 'left']}
        style={styles.safeArea}>
        <View
          testID="crm-modal-card"
          style={[cardStyle, styles.bounds]}
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}>
          <ScrollView
            accessibilityLabel={label}
            style={styles.scroll}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            nestedScrollEnabled
            showsVerticalScrollIndicator>
            {children}
          </ScrollView>
        </View>
      </SafeAreaView>
    </KeyboardSafeViewport>
  );
}

export const crmTouchTarget = { minWidth: 44, minHeight: 44 } as const;
const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)' },
  safeArea: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 12 },
  bounds: { width: '100%', maxWidth: 640, maxHeight: '100%', flexShrink: 1, minHeight: 0 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  content: { paddingBottom: 4 },
});
