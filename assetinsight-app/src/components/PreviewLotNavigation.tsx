import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

type Props = {
  count: number;
  position: 'top' | 'bottom';
  onJump: (edge: 'first' | 'last') => void;
};

/** Native previews already show every lot; navigation never slices the saved data. */
export default function PreviewLotNavigation({ count, position, onJump }: Props) {
  const noun = count === 1 ? 'lot' : 'lots';
  return (
    <View testID={`preview-lot-navigation-${position}`} style={styles.container}>
      <Text style={styles.title} accessibilityLiveRegion="polite">
        {count === 0 ? 'No lots in this preview' : position === 'top'
          ? `Showing all ${count} ${noun}` : `End of all ${count} ${noun}`}
      </Text>
      {count > 0 ? (
        <Text style={styles.description}>
          All {count} {noun} are in this list. There are no other pages.
        </Text>
      ) : null}
      {count > 1 ? (
        <View style={styles.actions}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Go to first lot"
            accessibilityHint="Scrolls to the first lot without changing your edits."
            style={styles.button}
            onPress={() => onJump('first')}
          >
            <Text style={styles.buttonText}>First lot</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Go to last lot"
            accessibilityHint="Scrolls to the last lot without changing your edits."
            style={styles.button}
            onPress={() => onJump('last')}
          >
            <Text style={styles.buttonText}>Last lot</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 6, backgroundColor: '#F8FAFC', borderBottomWidth: 1, borderColor: '#E5E7EB' },
  title: { fontSize: 14, fontWeight: '700', color: '#111827' },
  description: { fontSize: 12, color: '#4B5563' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  button: { flexGrow: 1, flexBasis: 120, minHeight: 44, padding: 10, borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  buttonText: { fontSize: 14, fontWeight: '600', color: '#334155', flexShrink: 1, textAlign: 'center' },
});
