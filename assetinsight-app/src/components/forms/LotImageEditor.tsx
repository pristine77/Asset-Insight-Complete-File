import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  LayoutChangeEvent,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Slider from '@react-native-community/slider';
import { Feather } from '@expo/vector-icons';
import {
  Canvas,
  CatmullRomCubicSampling,
  ColorMatrix,
  drawAsImage,
  Group,
  Image as SkiaImage,
  ImageFormat,
  RuntimeShader,
  Skia,
  useImage,
} from '@shopify/react-native-skia';

import type { ImageAdjustments, PhotoFile } from '../camera/types';
import { ImageEditService } from '../../services/imageEditService';
import {
  areImageAdjustmentsDefault,
  DEFAULT_IMAGE_ADJUSTMENTS,
  getPhotoOriginalUri,
  normalizeImageAdjustments,
} from '../../utils/photoFileUtils';

interface LotImageEditorProps {
  visible: boolean;
  photo: PhotoFile | null;
  lotId: string | null;
  canPaste: boolean;
  pastedAdjustments?: ImageAdjustments | null;
  onClose: () => void;
  onCopy: (adjustments: ImageAdjustments) => void;
  onSave: (payload: {
    adjustments?: ImageAdjustments;
    editedUri?: string | null;
  }) => Promise<void> | void;
}

const IMAGE_EDIT_EFFECT = Skia.RuntimeEffect.Make(`
uniform shader image;
uniform float2 resolution;
uniform float brightness;
uniform float contrast;
uniform float sharpness;
uniform float clarity;

half4 main(float2 xy) {
  float2 pixel = float2(
    1.0 / max(resolution.x, 1.0),
    1.0 / max(resolution.y, 1.0)
  );

  half4 center = image.eval(xy);
  half4 left = image.eval(xy + float2(-pixel.x, 0.0));
  half4 right = image.eval(xy + float2(pixel.x, 0.0));
  half4 up = image.eval(xy + float2(0.0, -pixel.y));
  half4 down = image.eval(xy + float2(0.0, pixel.y));
  half4 average = (center + left + right + up + down) / 5.0;

  half3 color = center.rgb;
  color = ((color - half3(0.5)) * contrast) + half3(0.5);
  color += half3(brightness);
  color += (center.rgb - average.rgb) * sharpness;

  half centerLuma = dot(center.rgb, half3(0.299, 0.587, 0.114));
  half averageLuma = dot(average.rgb, half3(0.299, 0.587, 0.114));
  color += half3(centerLuma - averageLuma) * clarity;

  return half4(clamp(color, 0.0, 1.0), center.a);
}
`);

const buildSaturationMatrix = (saturation: number) => {
  const inv = 1 - saturation;
  const r = 0.2126 * inv;
  const g = 0.7152 * inv;
  const b = 0.0722 * inv;

  return [
    r + saturation,
    g,
    b,
    0,
    0,
    r,
    g + saturation,
    b,
    0,
    0,
    r,
    g,
    b + saturation,
    0,
    0,
    0,
    0,
    0,
    1,
    0,
  ];
};

const getContainRect = (
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number
) => {
  if (containerWidth <= 0 || containerHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;

  return {
    x: (containerWidth - width) / 2,
    y: (containerHeight - height) / 2,
    width,
    height,
  };
};

const formatValue = (key: keyof ImageAdjustments, value: number) => {
  if (key === 'brightness') return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
  return value.toFixed(2);
};

const FilteredImageNode = ({
  image,
  adjustments,
  x,
  y,
  width,
  height,
}: {
  image: ReturnType<typeof useImage>;
  adjustments: ImageAdjustments;
  x: number;
  y: number;
  width: number;
  height: number;
}) => {
  if (!image || width <= 0 || height <= 0) return null;

  return (
    <SkiaImage
      image={image}
      x={x}
      y={y}
      width={width}
      height={height}
      fit="fill"
      sampling={CatmullRomCubicSampling}>
      {IMAGE_EDIT_EFFECT ? (
        <RuntimeShader
          source={IMAGE_EDIT_EFFECT}
          uniforms={{
            resolution: [width, height],
            brightness: adjustments.brightness,
            contrast: adjustments.contrast,
            sharpness: adjustments.sharpness,
            clarity: adjustments.clarity,
          }}>
          <ColorMatrix matrix={buildSaturationMatrix(adjustments.saturation)} />
        </RuntimeShader>
      ) : (
        <ColorMatrix matrix={buildSaturationMatrix(adjustments.saturation)} />
      )}
    </SkiaImage>
  );
};

const LotImageEditor: React.FC<LotImageEditorProps> = ({
  visible,
  photo,
  lotId,
  canPaste,
  pastedAdjustments,
  onClose,
  onCopy,
  onSave,
}) => {
  const sourceUri = photo ? getPhotoOriginalUri(photo) : '';
  const image = useImage(sourceUri);
  const [draftAdjustments, setDraftAdjustments] = useState<ImageAdjustments>(
    DEFAULT_IMAGE_ADJUSTMENTS
  );
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible || !photo) return;
    setDraftAdjustments(normalizeImageAdjustments(photo.adjustments) ?? DEFAULT_IMAGE_ADJUSTMENTS);
  }, [photo, visible]);

  const imageRect = useMemo(() => {
    if (!image) return { x: 0, y: 0, width: 0, height: 0 };

    return getContainRect(previewSize.width, previewSize.height, image.width(), image.height());
  }, [image, previewSize.height, previewSize.width]);

  const onPreviewLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setPreviewSize({ width, height });
  };

  const sliderConfig: {
    key: keyof ImageAdjustments;
    label: string;
    min: number;
    max: number;
    step: number;
  }[] = [
    { key: 'brightness', label: 'Brightness', min: -0.6, max: 0.6, step: 0.01 },
    { key: 'contrast', label: 'Contrast', min: 0.4, max: 1.8, step: 0.01 },
    { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01 },
    { key: 'sharpness', label: 'Sharpness', min: 0, max: 1.4, step: 0.01 },
    { key: 'clarity', label: 'Clarity', min: 0, max: 1.4, step: 0.01 },
  ];

  const handleChange = (key: keyof ImageAdjustments, value: number) => {
    setDraftAdjustments((previous) => ({
      ...previous,
      [key]: value,
    }));
  };

  const handleReset = () => {
    setDraftAdjustments(DEFAULT_IMAGE_ADJUSTMENTS);
  };

  const handleCopy = () => {
    onCopy(draftAdjustments);
  };

  const handlePaste = () => {
    if (!pastedAdjustments) return;
    setDraftAdjustments(pastedAdjustments);
  };

  const handleSave = async () => {
    if (!photo || !image || !lotId) return;

    setSaving(true);
    try {
      if (areImageAdjustmentsDefault(draftAdjustments)) {
        await onSave({ adjustments: undefined, editedUri: null });
        return;
      }

      const outputWidth = image.width();
      const outputHeight = image.height();
      const rendered = await drawAsImage(
        <Group>
          <FilteredImageNode
            image={image}
            adjustments={draftAdjustments}
            x={0}
            y={0}
            width={outputWidth}
            height={outputHeight}
          />
        </Group>,
        { width: outputWidth, height: outputHeight }
      );

      if (!rendered) {
        throw new Error('Failed to render edited image.');
      }

      const base64 = rendered.encodeToBase64(ImageFormat.JPEG, 100);
      const editedUri = await ImageEditService.saveEditedImageBase64(base64, lotId, photo.name, getPhotoOriginalUri(photo));

      await onSave({
        adjustments: draftAdjustments,
        editedUri,
      });
    } catch (error) {
      console.error('[LotImageEditor] Save failed:', error);
      Alert.alert('Save Failed', 'Unable to save the edited image.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.headerButton} onPress={onClose} disabled={saving}>
            <Feather name="x" size={20} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title}>Edit Image</Text>
          <TouchableOpacity
            style={[styles.headerButton, styles.headerButtonPrimary]}
            onPress={() => {
              void handleSave();
            }}
            disabled={saving || !image}>
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Feather name="check" size={20} color="#fff" />
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.previewCard} onLayout={onPreviewLayout}>
          {image ? (
            <Canvas style={styles.previewCanvas}>
              <FilteredImageNode
                image={image}
                adjustments={draftAdjustments}
                x={imageRect.x}
                y={imageRect.y}
                width={imageRect.width}
                height={imageRect.height}
              />
            </Canvas>
          ) : (
            <View style={styles.previewFallback}>
              <ActivityIndicator size="large" color="#2563EB" />
              <Text style={styles.previewFallbackText}>Loading image...</Text>
            </View>
          )}
        </View>

        <ScrollView
          style={styles.controls}
          contentContainerStyle={styles.controlsContent}
          showsVerticalScrollIndicator={false}>
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.actionButton} onPress={handleReset} disabled={saving}>
              <Feather name="rotate-ccw" size={16} color="#111827" />
              <Text style={styles.actionButtonText}>Reset</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton} onPress={handleCopy} disabled={saving}>
              <Feather name="copy" size={16} color="#111827" />
              <Text style={styles.actionButtonText}>Copy edits</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, !canPaste && styles.actionButtonDisabled]}
              onPress={handlePaste}
              disabled={saving || !canPaste}>
              <Feather name="clipboard" size={16} color="#111827" />
              <Text style={styles.actionButtonText}>Paste edits</Text>
            </TouchableOpacity>
          </View>

          {sliderConfig.map((slider) => (
            <View key={slider.key} style={styles.sliderBlock}>
              <View style={styles.sliderHeader}>
                <Text style={styles.sliderLabel}>{slider.label}</Text>
                <Text style={styles.sliderValue}>{formatValue(slider.key, draftAdjustments[slider.key])}</Text>
              </View>
              <Slider
                minimumValue={slider.min}
                maximumValue={slider.max}
                step={slider.step}
                minimumTrackTintColor="#2563EB"
                maximumTrackTintColor="#D1D5DB"
                thumbTintColor="#2563EB"
                value={draftAdjustments[slider.key]}
                onValueChange={(value) => handleChange(slider.key, value)}
              />
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  headerButtonPrimary: {
    backgroundColor: '#2563EB',
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  previewCard: {
    flex: 1,
    marginHorizontal: 16,
    marginBottom: 14,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#020617',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  previewCanvas: {
    flex: 1,
  },
  previewFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  previewFallbackText: {
    color: '#CBD5E1',
    fontSize: 14,
  },
  controls: {
    maxHeight: 320,
    backgroundColor: '#F8FAFC',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  controlsContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 16,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionButton: {
    flex: 1,
    height: 42,
    borderRadius: 14,
    backgroundColor: '#E2E8F0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  actionButtonDisabled: {
    opacity: 0.45,
  },
  actionButtonText: {
    color: '#111827',
    fontSize: 12,
    fontWeight: '700',
  },
  sliderBlock: {
    gap: 8,
  },
  sliderHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sliderLabel: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '700',
  },
  sliderValue: {
    color: '#475569',
    fontSize: 13,
    fontWeight: '600',
  },
});

export default LotImageEditor;
