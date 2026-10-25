import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, 'LotManager.tsx'), 'utf8');
const assetSource = fs.readFileSync(path.join(__dirname, 'AssetFormSheet.tsx'), 'utf8');

// These guard source/layout wiring; real image rendering is checked on Android.
describe('lot photo viewer Android compatibility', () => {
  it('keeps Asset offline status and camera controls inside the same bounded scroll viewport', () => {
    const imagesScroll = assetSource.slice(assetSource.indexOf('<ScrollView testID="asset-images-scroll"'));
    const scrollContents = imagesScroll.slice(0, imagesScroll.indexOf('</ScrollView>'));
    expect(scrollContents).toContain('<OfflineCapturePanel');
    expect(scrollContents).toMatch(/<LotManager\s+embedded/);
    expect(assetSource).toContain("imagesScroll: { flex: 1, minHeight: 0 }");
    expect(assetSource).toMatch(/actionRow:\s*\{\s*flexDirection: 'row',\s*flexWrap: 'wrap'/);
  });
  it('imports the supported SDK54 legacy filesystem API', () => {
    expect(source).toContain("import * as FileSystem from 'expo-file-system/legacy'");
    expect(source).not.toContain("import * as FileSystem from 'expo-file-system'");
  });

  it('only adds a file scheme to bare paths, preserving content URIs', () => {
    expect(source).toContain("const fileInfoUri = uri.startsWith('/') ? `file://${uri}` : uri;");
    expect(source).toContain('FileSystem.getInfoAsync(fileInfoUri)');
    expect(source).not.toContain('urisToTry');
  });

  it('gives the image a sized parent instead of an intrinsic zero-size wrapper', () => {
    expect(source).toMatch(/<TouchableOpacity\s+style=\{styles\.viewerImageFrame\}/);
    expect(source).toMatch(/viewerImageFrame:\s*\{\s*width: '100%',\s*height: '70%',/);
    expect(source).toMatch(/viewerImage:\s*\{\s*width: '100%',\s*height: '100%',/);
  });

  it('renders the selected display URI directly without changing the image source', () => {
    expect(source).toContain('source={{ uri: selectedImage.uri }}');
  });

  it('does not report settled unavailable metadata as still loading', () => {
    expect(source).toMatch(/selectedImage\.width > 0[\s\S]*?: 'Unavailable'/);
    expect(source).toContain(
      "selectedImage.size > 0 ? formatFileSize(selectedImage.size) : 'Unavailable'"
    );
    expect(source).not.toContain("'Loading...'");
    expect(source).toContain('selectedImage && !loadingImageInfo');
  });
});
