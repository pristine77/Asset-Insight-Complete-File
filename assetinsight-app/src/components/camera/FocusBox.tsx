import React, { useState, useRef, useCallback, useEffect, memo } from 'react';
import {
  View,
  StyleSheet,
  Dimensions,
  PanResponder,
  TouchableOpacity,
  Text,
  Animated,
  Easing,
  Platform,
  UIManager,
} from 'react-native';
import { Feather } from '@expo/vector-icons';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface FocusBoxProps {
  visible: boolean;
  isLandscape?: boolean;
  viewWidth?: number;
  viewHeight?: number;
  onBoxChange?: (rect: { x: number; y: number; width: number; height: number }) => void;
}

const MIN_SIZE = 80;
const MAX_SIZE_RATIO = 0.9;

const FocusBoxComponent: React.FC<FocusBoxProps> = ({
  visible,
  isLandscape = false,
  viewWidth,
  viewHeight,
  onBoxChange,
}) => {
  const { width: winWidth, height: winHeight } = Dimensions.get('window');
  const screenWidth = Number.isFinite(viewWidth) && (viewWidth || 0) > 0 ? (viewWidth as number) : winWidth;
  const screenHeight = Number.isFinite(viewHeight) && (viewHeight || 0) > 0 ? (viewHeight as number) : winHeight;

  // Default size based on orientation
  const defaultWidth = isLandscape ? screenWidth * 0.4 : screenWidth * 0.55;
  const defaultHeight = isLandscape ? screenHeight * 0.55 : screenHeight * 0.3;

  // Use Animated.ValueXY for smooth position
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const minimizedProgress = useRef(new Animated.Value(0)).current;

  // State for size (using state for resize since it needs re-render)
  const [size, setSize] = useState({ width: defaultWidth, height: defaultHeight });
  const [isMinimized, setIsMinimized] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Refs to track gesture state
  const lastPan = useRef({ x: 0, y: 0 });
  const lastSize = useRef({ width: defaultWidth, height: defaultHeight });
  const sizeRef = useRef({ width: defaultWidth, height: defaultHeight });
  const screenSizeRef = useRef({ width: screenWidth, height: screenHeight });
  const resizeFrameRef = useRef<number | null>(null);

  useEffect(() => {
    screenSizeRef.current = { width: screenWidth, height: screenHeight };
  }, [screenHeight, screenWidth]);

  const syncSize = useCallback((nextSize: { width: number; height: number }, immediate = false) => {
    sizeRef.current = nextSize;
    lastSize.current = nextSize;

    if (immediate) {
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      setSize(nextSize);
      return;
    }

    if (resizeFrameRef.current !== null) return;

    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      setSize(sizeRef.current);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (visible) return;
    minimizedProgress.stopAnimation();
    minimizedProgress.setValue(0);
    setIsMinimized(false);
    setIsDragging(false);
  }, [minimizedProgress, visible]);

  const emitBoxChange = useCallback(
    (
      nextSize: { width: number; height: number } = sizeRef.current,
      nextPan: { x: number; y: number } = lastPan.current
    ) => {
      if (!onBoxChange) return;
      const currentScreenWidth = screenSizeRef.current.width;
      const currentScreenHeight = screenSizeRef.current.height;
      const x = currentScreenWidth / 2 - nextSize.width / 2 + nextPan.x;
      const y = currentScreenHeight / 2 - nextSize.height / 2 + nextPan.y;
      const clampedX = Math.max(0, Math.min(x, Math.max(0, currentScreenWidth - nextSize.width)));
      const clampedY = Math.max(0, Math.min(y, Math.max(0, currentScreenHeight - nextSize.height)));
      onBoxChange({ x: clampedX, y: clampedY, width: nextSize.width, height: nextSize.height });
    },
    [onBoxChange]
  );

  useEffect(() => {
    emitBoxChange();
  }, [emitBoxChange, visible]);

  // Update defaults when orientation changes
  useEffect(() => {
    const newWidth = isLandscape ? screenWidth * 0.4 : screenWidth * 0.55;
    const newHeight = isLandscape ? screenHeight * 0.55 : screenHeight * 0.3;
    const nextSize = { width: newWidth, height: newHeight };
    syncSize(nextSize, true);
    pan.stopAnimation();
    pan.setOffset({ x: 0, y: 0 });
    pan.setValue({ x: 0, y: 0 });
    lastPan.current = { x: 0, y: 0 };
    emitBoxChange(nextSize, { x: 0, y: 0 });
  }, [emitBoxChange, isLandscape, pan, screenWidth, screenHeight, syncSize]);

  // Clamp position to screen bounds
  const clampPosition = useCallback(
    (x: number, y: number, w: number, h: number) => {
      const maxX = (screenSizeRef.current.width - w) / 2;
      const maxY = (screenSizeRef.current.height - h) / 2;
      return {
        x: Math.max(-maxX, Math.min(maxX, x)),
        y: Math.max(-maxY, Math.min(maxY, y)),
      };
    },
    []
  );

  const finishDrag = useCallback(
    (dx: number, dy: number) => {
      pan.flattenOffset();
      const currentSize = sizeRef.current;
      const clamped = clampPosition(
        lastPan.current.x + dx,
        lastPan.current.y + dy,
        currentSize.width,
        currentSize.height
      );
      lastPan.current = clamped;
      pan.setValue(clamped);
      emitBoxChange(currentSize, clamped);
      setIsDragging(false);
    },
    [clampPosition, emitBoxChange, pan]
  );

  // Main drag PanResponder - for moving the entire box
  const dragResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 2 || Math.abs(gs.dy) > 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        pan.stopAnimation();
        pan.setOffset({ x: lastPan.current.x, y: lastPan.current.y });
        pan.setValue({ x: 0, y: 0 });
        setIsDragging(true);
      },
      onPanResponderMove: (_, gs) => {
        const currentSize = sizeRef.current;
        const clamped = clampPosition(
          lastPan.current.x + gs.dx,
          lastPan.current.y + gs.dy,
          currentSize.width,
          currentSize.height
        );
        pan.setValue({
          x: clamped.x - lastPan.current.x,
          y: clamped.y - lastPan.current.y,
        });
      },
      onPanResponderRelease: (_, gs) => finishDrag(gs.dx, gs.dy),
      onPanResponderTerminate: (_, gs) => finishDrag(gs.dx, gs.dy),
    })
  ).current;

  // Helper to calculate new size from gesture
  const calcNewSize = useCallback(
    (corner: 'tl' | 'tr' | 'bl' | 'br', dx: number, dy: number, startSize: { width: number; height: number }) => {
      let dw = 0;
      let dh = 0;

      if (corner === 'br') {
        dw = dx * 2;
        dh = dy * 2;
      } else if (corner === 'bl') {
        dw = -dx * 2;
        dh = dy * 2;
      } else if (corner === 'tr') {
        dw = dx * 2;
        dh = -dy * 2;
      } else if (corner === 'tl') {
        dw = -dx * 2;
        dh = -dy * 2;
      }

      return {
        width: Math.max(
          MIN_SIZE,
          Math.min(screenSizeRef.current.width * MAX_SIZE_RATIO, startSize.width + dw)
        ),
        height: Math.max(
          MIN_SIZE,
          Math.min(screenSizeRef.current.height * MAX_SIZE_RATIO, startSize.height + dh)
        ),
      };
    },
    []
  );

  // Create resize responder for a corner - uses ref to track start size
  const createResizeResponder = useCallback(
    (corner: 'tl' | 'tr' | 'bl' | 'br') => {
      const startSizeRef = { width: 0, height: 0 };
      
      return PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          // Capture current size at gesture start
          startSizeRef.width = lastSize.current.width;
          startSizeRef.height = lastSize.current.height;
        },
        onPanResponderMove: (_, gs) => {
          const newSize = calcNewSize(corner, gs.dx, gs.dy, startSizeRef);
          syncSize(newSize);
        },
        onPanResponderRelease: (_, gs) => {
          // Calculate final size from gesture and update lastSize
          const finalSize = calcNewSize(corner, gs.dx, gs.dy, startSizeRef);
          syncSize(finalSize, true);
          emitBoxChange(finalSize);
        },
        onPanResponderTerminate: (_, gs) => {
          const finalSize = calcNewSize(corner, gs.dx, gs.dy, startSizeRef);
          syncSize(finalSize, true);
          emitBoxChange(finalSize);
        },
      });
    },
    [calcNewSize, emitBoxChange, syncSize]
  );

  // Create resize responders once
  const resizeTL = useRef(createResizeResponder('tl'));
  const resizeTR = useRef(createResizeResponder('tr'));
  const resizeBL = useRef(createResizeResponder('bl'));
  const resizeBR = useRef(createResizeResponder('br'));

  const toggleMinimize = useCallback(() => {
    setIsMinimized((prev) => {
      const next = !prev;
      minimizedProgress.stopAnimation();
      Animated.timing(minimizedProgress, {
        toValue: next ? 1 : 0,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return next;
    });
  }, [minimizedProgress]);

  const resetBox = useCallback(() => {
    const nextSize = { width: defaultWidth, height: defaultHeight };
    syncSize(nextSize, true);
    pan.stopAnimation();
    pan.setOffset({ x: 0, y: 0 });
    Animated.spring(pan, {
      toValue: { x: 0, y: 0 },
      useNativeDriver: false,
      friction: 7,
      tension: 40,
    }).start(() => {
      emitBoxChange(nextSize, { x: 0, y: 0 });
    });
    lastPan.current = { x: 0, y: 0 };
  }, [defaultWidth, defaultHeight, emitBoxChange, pan, syncSize]);

  if (!visible) return null;

  // Calculate box center position for corner placement
  const boxCenterX = screenWidth / 2;
  const boxCenterY = screenHeight / 2;
  const boxOpacity = minimizedProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0],
  });
  const boxScale = minimizedProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.94],
  });
  const minimizedOpacity = minimizedProgress;
  const minimizedScale = minimizedProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.92, 1],
  });

  return (
    <View style={styles.container} pointerEvents="box-none">
      <Animated.View
        style={[
          styles.minimizedContainer,
          isLandscape && styles.minimizedContainerLandscape,
          {
            opacity: minimizedOpacity,
            transform: [{ scale: minimizedScale }],
          },
        ]}
        pointerEvents={isMinimized ? 'auto' : 'none'}>
        <TouchableOpacity style={styles.minimizedButton} onPress={toggleMinimize}>
          <Feather name="maximize-2" size={16} color="#EF4444" />
          <Text style={styles.minimizedText}>Focus</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Main focus box - draggable */}
      <Animated.View
        pointerEvents={isMinimized ? 'none' : 'auto'}
        style={[
          styles.focusBox,
          {
            width: size.width,
            height: size.height,
            transform: [...pan.getTranslateTransform(), { scale: boxScale }],
            opacity: isDragging ? 0.9 : boxOpacity,
          },
        ]}
        {...dragResponder.panHandlers}>
        {/* Center move indicator */}
        <View style={styles.dragIndicator}>
          <Feather name="move" size={20} color="rgba(239,68,68,0.7)" />
        </View>

        {/* Control buttons */}
        <View style={styles.controlButtons}>
          <TouchableOpacity style={styles.controlBtn} onPress={toggleMinimize} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="minimize-2" size={14} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.controlBtn} onPress={resetBox} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="refresh-cw" size={14} color="#fff" />
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* Resize corners - OUTSIDE the main box so they can capture gestures */}
      <Animated.View
        pointerEvents={isMinimized ? 'none' : 'auto'}
        style={[
          styles.corner,
          {
            left: boxCenterX - size.width / 2 - 22,
            top: boxCenterY - size.height / 2 - 22,
            transform: [...pan.getTranslateTransform(), { scale: boxScale }],
            opacity: boxOpacity,
          },
        ]}
        {...resizeTL.current.panHandlers}>
        <View style={styles.cornerInner} />
      </Animated.View>

      <Animated.View
        pointerEvents={isMinimized ? 'none' : 'auto'}
        style={[
          styles.corner,
          {
            left: boxCenterX + size.width / 2 - 22,
            top: boxCenterY - size.height / 2 - 22,
            transform: [...pan.getTranslateTransform(), { scale: boxScale }],
            opacity: boxOpacity,
          },
        ]}
        {...resizeTR.current.panHandlers}>
        <View style={styles.cornerInner} />
      </Animated.View>

      <Animated.View
        pointerEvents={isMinimized ? 'none' : 'auto'}
        style={[
          styles.corner,
          {
            left: boxCenterX - size.width / 2 - 22,
            top: boxCenterY + size.height / 2 - 22,
            transform: [...pan.getTranslateTransform(), { scale: boxScale }],
            opacity: boxOpacity,
          },
        ]}
        {...resizeBL.current.panHandlers}>
        <View style={styles.cornerInner} />
      </Animated.View>

      <Animated.View
        pointerEvents={isMinimized ? 'none' : 'auto'}
        style={[
          styles.corner,
          {
            left: boxCenterX + size.width / 2 - 22,
            top: boxCenterY + size.height / 2 - 22,
            transform: [...pan.getTranslateTransform(), { scale: boxScale }],
            opacity: boxOpacity,
          },
        ]}
        {...resizeBR.current.panHandlers}>
        <View style={styles.cornerInner} />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  minimizedContainer: {
    position: 'absolute',
    top: 100,
    right: 10,
  },
  minimizedContainerLandscape: {
    top: 50,
    right: 120,
  },
  minimizedButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#EF4444',
    gap: 4,
  },
  minimizedText: {
    color: '#EF4444',
    fontSize: 11,
    fontWeight: '600',
  },
  focusBox: {
    borderWidth: 2.5,
    borderColor: '#EF4444',
    borderRadius: 4,
    backgroundColor: 'transparent',
  },
  dragIndicator: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -12,
    marginLeft: -12,
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
    opacity: 0.6,
  },
  moveHandle: {
    position: 'absolute',
    top: -28,
    left: '50%',
    marginLeft: -20,
    width: 40,
    height: 24,
    backgroundColor: 'rgba(239,68,68,0.9)',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  controlButtons: {
    position: 'absolute',
    top: -28,
    right: 0,
    flexDirection: 'row',
    gap: 4,
  },
  controlBtn: {
    width: 28,
    height: 28,
    backgroundColor: 'rgba(239,68,68,0.9)',
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  corner: {
    position: 'absolute',
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  cornerInner: {
    width: 20,
    height: 20,
    borderColor: '#EF4444',
    borderWidth: 3,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 4,
  },
});

const FocusBox = memo(FocusBoxComponent);

export default FocusBox;
