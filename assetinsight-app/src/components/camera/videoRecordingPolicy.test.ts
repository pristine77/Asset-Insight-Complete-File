import { supportsRequiredVideoSession } from './videoRecordingPolicy';

describe('required video format', () => {
  it.each([[1280, 720], [720, 1280]])('accepts HD in either orientation (%s × %s)', (width, height) => {
    expect(supportsRequiredVideoSession({ width, height }, 30)).toBe(true);
  });
  it.each([undefined, 0, 24, 60, NaN])('rejects missing/unsupported frame rate %s', (fps) => {
    expect(supportsRequiredVideoSession({ width: 1280, height: 720 }, fps)).toBe(false);
  });
  it('rejects an output that has not been attached/configured', () => {
    expect(supportsRequiredVideoSession(undefined, 30)).toBe(false);
  });
});
