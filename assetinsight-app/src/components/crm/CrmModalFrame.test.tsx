import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, TouchableOpacity } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import CrmModalFrame from './CrmModalFrame';
import { keyboardAvoidingBehavior } from '../KeyboardSafeViewport';

jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: jest.requireActual('react-native').View }));

function Notes({ onMount }: { onMount: () => void }) {
  const [value, setValue] = useState('');
  useEffect(onMount, [onMount]);
  return <TextInput accessibilityLabel="Notes" multiline value={value} onChangeText={setValue} />;
}

it.each(['ios', 'android'] as const)(
  'uses bounded safe-area scrolling and %s keyboard avoidance',
  async (os) => {
    const previous = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
    try {
      const onClose = jest.fn();
      await render(
        <CrmModalFrame
          label="CRM form"
          onClose={onClose}
          cardStyle={{ maxHeight: '86%', padding: 16 }}>
          <Text>Long contents</Text>
          <TouchableOpacity accessibilityRole="button" onPress={onClose}>
            <Text>Cancel</Text>
          </TouchableOpacity>
        </CrmModalFrame>
      );
      expect(keyboardAvoidingBehavior(os)).toBe(os === 'ios' ? 'padding' : 'height');
      const scroll = screen.getByLabelText('CRM form');
      expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
      expect(scroll.props.nestedScrollEnabled).toBe(true);
      expect(scroll.props.keyboardDismissMode).toBe(os === 'ios' ? 'interactive' : 'on-drag');
      expect(StyleSheet.flatten(screen.getByTestId('crm-modal-card').props.style)).toEqual(
        expect.objectContaining({ maxHeight: '100%', maxWidth: 640, flexShrink: 1 })
      );
      expect(screen.getByTestId('crm-modal-safe-area').props.edges).toEqual([
        'top',
        'right',
        'bottom',
        'left',
      ]);
      await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: previous });
    }
  }
);

it('keeps input identity and multiline draft content while the parent rerenders', async () => {
  const onMount = jest.fn();
  const result = await render(
    <CrmModalFrame label="CRM form">
      <Notes onMount={onMount} />
    </CrmModalFrame>
  );
  await fireEvent.changeText(screen.getByLabelText('Notes'), 'Line one\nLine two');
  await result.rerender(
    <CrmModalFrame label="CRM form" cardStyle={{ padding: 10 }}>
      <Notes onMount={onMount} />
    </CrmModalFrame>
  );
  expect(screen.getByLabelText('Notes').props.value).toBe('Line one\nLine two');
  expect(onMount).toHaveBeenCalledTimes(1);
});
