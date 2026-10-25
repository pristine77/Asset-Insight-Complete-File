import { Image } from 'react-native';
import {
  ImageFormat,
  Skia,
  type SkImage,
  type SkPaint,
  type SkSurface,
} from '@shopify/react-native-skia';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { randomUUID } from 'expo-crypto';
import { addPhotoWatermarkReceipt, photoBytesToBase64 } from '../utils/photoWatermarkReceipt';
import { CAMERA_PHOTO_JPEG_QUALITY, fitInsideBox } from '../utils/cameraPhotoSize';

const logoAsset = require('../../modules/auction-camera/android/src/main/res/drawable/ic_app_img.png');

/** Capture only; never invoke for gallery imports or edited photos. */
export async function stampCameraPhoto(uri: string): Promise<string> {
  const normalized = await ImageManipulator.manipulateAsync(uri, [], {
    compress: 1,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  let image: SkImage | null = null;
  let logo: SkImage | null = null;
  let surface: SkSurface | null = null;
  let paint: SkPaint | null = null;
  let snapshot: SkImage | null = null;
  try {
    image = Skia.Image.MakeImageFromEncoded(await Skia.Data.fromURI(normalized.uri));
    logo = Skia.Image.MakeImageFromEncoded(
      await Skia.Data.fromURI(Image.resolveAssetSource(logoAsset).uri)
    );
    if (!image || !logo) throw new Error('Unable to prepare the camera watermark');
    // Preserve the pre-reduction 3000 px longest side, without enlargement.
    const { width, height } = fitInsideBox(image.width(), image.height());
    surface = Skia.Surface.MakeOffscreen(width, height);
    if (!surface) throw new Error('Unable to prepare the camera photo');
    const canvas = surface.getCanvas();
    paint = Skia.Paint();
    canvas.drawImageRect(
      image,
      Skia.XYWHRect(0, 0, image.width(), image.height()),
      Skia.XYWHRect(0, 0, width, height),
      paint
    );
    const logoWidth = width * 0.2;
    const logoHeight = (logoWidth * logo.height()) / logo.width();
    const margin = width * 0.03;
    paint.setAlphaf(200 / 255);
    canvas.drawImageRect(
      logo,
      Skia.XYWHRect(0, 0, logo.width(), logo.height()),
      Skia.XYWHRect(
        Math.max(0, width - logoWidth - margin),
        Math.max(0, height - logoHeight - margin),
        logoWidth,
        logoHeight
      ),
      paint
    );
    surface.flush();
    snapshot = surface.makeImageSnapshot();
    // Restore the JS camera's original fixed-quality encoding policy.
    const bytes = snapshot.encodeToBytes(ImageFormat.JPEG, CAMERA_PHOTO_JPEG_QUALITY);
    if (!bytes) throw new Error('Unable to encode the camera photo');
    const marked = await addPhotoWatermarkReceipt(bytes);
    if (!FileSystem.documentDirectory) throw new Error('Photo storage is unavailable');
    const directory = `${FileSystem.documentDirectory}camera-photos/`;
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    const destination = `${directory}${randomUUID()}.jpg`;
    await FileSystem.writeAsStringAsync(destination, photoBytesToBase64(marked), {
      encoding: FileSystem.EncodingType.Base64,
    });
    return destination;
  } finally {
    snapshot?.dispose();
    paint?.dispose();
    image?.dispose();
    logo?.dispose();
    surface?.dispose();
    if (normalized.uri !== uri)
      await FileSystem.deleteAsync(normalized.uri, { idempotent: true }).catch(() => {});
  }
}
