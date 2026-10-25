import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

interface Props {
  children: React.ReactNode;
  /** Full, unshrunk frame; keep alignment of dialog contents in contentStyle or its children. */
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

export const keyboardAvoidingBehavior = (platform: string) =>
  platform === 'ios' ? 'padding' : 'height';

export function visibleKeyboardViewportHeight(
  frameHeight: number,
  frameTop: number,
  keyboardTop: number | null
): number {
  if (keyboardTop === null || !Number.isFinite(keyboardTop)) return frameHeight;
  return Math.max(0, Math.min(frameHeight, keyboardTop - frameTop));
}

/**
 * Bound scrollable modal contents above the IME, including Android edge-to-edge dialogs.
 * The measured parent prevents a second subtraction on devices already using adjustResize.
 * Safe-area padding, alignment, scrolling and appearance remain the caller's responsibility.
 */
export default function KeyboardSafeViewport({
  children,
  style,
  contentStyle,
  testID = 'keyboard-safe-viewport',
}: Props) {
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const frame = useRef<View>(null);
  const [frameTop, setFrameTop] = useState(0);
  const [frameHeight, setFrameHeight] = useState(windowHeight);
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const measureTop = useCallback(() => {
    frame.current?.measureInWindow((_x, y) => {
      if (Number.isFinite(y)) setFrameTop(y);
    });
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    setKeyboardTop(Keyboard.metrics()?.screenY ?? null);
    measureTop();
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      setKeyboardTop(event.endCoordinates.screenY);
      measureTop();
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardTop(null));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [measureTop, windowHeight, windowWidth]);

  const visibleHeight = visibleKeyboardViewportHeight(frameHeight, frameTop, keyboardTop);
  return (
    <View
      ref={frame}
      testID={testID}
      style={[styles.frame, style]}
      onLayout={(event) => {
        setFrameHeight(event.nativeEvent.layout.height);
        measureTop();
      }}>
      <KeyboardAvoidingView
        testID={`${testID}-content`}
        // Percentage-bound descendants can ignore automatic KAV height in edge-to-edge Modals.
        style={[
          styles.frame,
          contentStyle,
          Platform.OS === 'android' && keyboardTop !== null && { height: visibleHeight, flex: 0 },
        ]}
        enabled={Platform.OS === 'ios'}
        behavior={keyboardAvoidingBehavior(Platform.OS)}
        keyboardVerticalOffset={0}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({ frame: { flex: 1 } });
