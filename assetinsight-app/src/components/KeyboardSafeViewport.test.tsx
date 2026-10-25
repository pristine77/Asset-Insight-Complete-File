import React from 'react';
import { Keyboard, Platform, StyleSheet, Text, type KeyboardEvent } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import KeyboardSafeViewport, { visibleKeyboardViewportHeight } from './KeyboardSafeViewport';

it.each([
  [780, 0, null, 780],
  [780, 0, 481, 481],
  [780, 24, 481, 457],
  [457, 24, 481, 457],
  [360, 0, 481, 360],
  [780, 100, 80, 0],
  [780, 0, Number.NaN, 780],
])(
  'bounds height %s at frame top %s and keyboard top %s to %s',
  (height, top, keyboard, expected) => {
    expect(visibleKeyboardViewportHeight(height, top, keyboard)).toBe(expected);
  }
);

const keyboardEvent = (screenY: number): KeyboardEvent => ({
  duration: 0,
  easing: 'keyboard',
  endCoordinates: { screenX: 0, screenY, width: 360, height: 780 - screenY },
});

it.each([false, true])(
  'handles keyboard events, resizing and cleanup (initially visible: %s)',
  async (initiallyVisible) => {
    const previousPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const metrics = jest
      .spyOn(Keyboard, 'metrics')
      .mockReturnValue(initiallyVisible ? keyboardEvent(481).endCoordinates : undefined);
    const callbacks = new Map<string, ((event: KeyboardEvent) => void)[]>();
    const subscriptions: jest.Mock[] = [];
    const listeners = jest.spyOn(Keyboard, 'addListener').mockImplementation((name, callback) => {
      callbacks.set(name, [...(callbacks.get(name) ?? []), callback]);
      const remove = jest.fn();
      subscriptions.push(remove);
      return { remove } as unknown as ReturnType<typeof Keyboard.addListener>;
    });
    try {
      const result = await render(
        <KeyboardSafeViewport testID="test-viewport" contentStyle={{ backgroundColor: 'white' }}>
          <Text>Preserved contents</Text>
        </KeyboardSafeViewport>
      );
      const layout = async (height: number) => {
        await fireEvent(screen.getByTestId('test-viewport'), 'layout', {
          nativeEvent: { layout: { x: 0, y: 0, width: 360, height } },
        });
      };
      const contentStyle = () =>
        StyleSheet.flatten(screen.getByTestId('test-viewport-content').props.style);
      await layout(780);
      if (initiallyVisible) expect(contentStyle()).toMatchObject({ height: 481, flex: 0 });
      else expect(contentStyle()).toMatchObject({ flex: 1 });
      await act(() =>
        callbacks.get('keyboardDidShow')?.forEach((callback) => callback(keyboardEvent(481)))
      );
      expect(contentStyle()).toMatchObject({ height: 481, flex: 0, backgroundColor: 'white' });
      // An already resized dialog or landscape viewport must not subtract the IME a second time.
      await layout(350);
      expect(contentStyle()).toMatchObject({ height: 350, flex: 0 });
      await act(() =>
        callbacks.get('keyboardDidShow')?.forEach((callback) => callback(keyboardEvent(220)))
      );
      expect(contentStyle()).toMatchObject({ height: 220, flex: 0 });
      await act(() =>
        callbacks.get('keyboardDidHide')?.forEach((callback) => callback(keyboardEvent(780)))
      );
      expect(contentStyle()).toMatchObject({ flex: 1 });
      expect(contentStyle().height).toBeUndefined();
      expect(screen.getByText('Preserved contents')).toBeTruthy();
      await result.unmount();
      expect(subscriptions.length).toBeGreaterThanOrEqual(2);
      subscriptions.forEach((remove) => expect(remove).toHaveBeenCalledTimes(1));
    } finally {
      metrics.mockRestore();
      listeners.mockRestore();
      Object.defineProperty(Platform, 'OS', { configurable: true, value: previousPlatform });
    }
  }
);
