import {
  inferSupportMediaType,
  SUPPORT_IMAGE_MAX_BYTES,
  SUPPORT_VIDEO_MAX_BYTES,
  validateSupportMedia,
} from './supportMedia';

describe('support media policy', () => {
  it('recognizes supported image and video picker output', () => {
    expect(inferSupportMediaType({ fileName: 'failure.PNG' })).toEqual({
      kind: 'image',
      contentType: 'image/png',
    });
    expect(inferSupportMediaType({ fileName: 'recording.mov', assetType: 'video' })).toEqual({
      kind: 'video',
      contentType: 'video/quicktime',
    });
    expect(inferSupportMediaType({ fileName: 'notes.pdf' })).toBeNull();
  });

  it('enforces different bounded sizes for images and videos', () => {
    const image = {
      uri: 'file:///error.jpg',
      fileName: 'error.jpg',
      contentType: 'image/jpeg',
      kind: 'image' as const,
    };
    const video = {
      uri: 'file:///error.mp4',
      fileName: 'error.mp4',
      contentType: 'video/mp4',
      kind: 'video' as const,
    };

    expect(validateSupportMedia({ ...image, size: SUPPORT_IMAGE_MAX_BYTES })).toBeNull();
    expect(validateSupportMedia({ ...image, size: SUPPORT_IMAGE_MAX_BYTES + 1 })).toMatch(/20 MB/);
    expect(validateSupportMedia({ ...video, size: SUPPORT_VIDEO_MAX_BYTES })).toBeNull();
    expect(validateSupportMedia({ ...video, size: SUPPORT_VIDEO_MAX_BYTES + 1 })).toMatch(/250 MB/);
  });
});
