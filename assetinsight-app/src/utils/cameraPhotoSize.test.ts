import { CAMERA_PHOTO_BOX, CAMERA_PHOTO_JPEG_QUALITY, CAMERA_PHOTO_MAX_SIDE, fitInsideBox } from './cameraPhotoSize';

describe('standard camera photo size', () => {
  it('restores the pre-reduction 3000 px longest side and fixed JPEG quality 95', () => {
    expect(CAMERA_PHOTO_MAX_SIDE).toBe(3000);
    expect(CAMERA_PHOTO_BOX).toEqual({ width: 3000, height: 3000 });
    expect(CAMERA_PHOTO_JPEG_QUALITY).toBe(95);
  });

  it.each([
    ['a 12 MP landscape photo', 4032, 3024, 3000, 2250],
    ['a 4000 x 3000 landscape photo', 4000, 3000, 3000, 2250],
    ['a 4K landscape photo', 3840, 2160, 3000, 1688],
    ['a 3:4 portrait photo', 3024, 4032, 2250, 3000],
    ['a 4K portrait photo', 2160, 3840, 1688, 3000],
    ['a photo already exactly the size', 3000, 2250, 3000, 2250],
    ['a photo one pixel too wide', 3001, 2000, 3000, 1999],
  ])('limits %s to 3000 px on its longest side', (_label, w, h, expectedW, expectedH) => {
    expect(fitInsideBox(w, h)).toEqual({ width: expectedW, height: expectedH });
  });

  it('never enlarges a smaller photo', () => {
    expect(fitInsideBox(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitInsideBox(1080, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(fitInsideBox(1000, 700)).toEqual({ width: 1000, height: 700 });
    expect(fitInsideBox(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it('passes an unreadable size through unchanged rather than inventing one', () => {
    expect(fitInsideBox(0, 900)).toEqual({ width: 0, height: 900 });
    expect(fitInsideBox(Number.NaN, 900)).toEqual({ width: Number.NaN, height: 900 });
  });

  it('accepts another box, as the 12 MP option uses on Android', () => {
    expect(fitInsideBox(8000, 6000, { width: 6000, height: 6000 })).toEqual({ width: 6000, height: 4500 });
  });
});
