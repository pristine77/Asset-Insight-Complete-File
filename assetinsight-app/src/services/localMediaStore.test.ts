import * as FileSystem from 'expo-file-system/legacy';
import { LocalMediaStore } from './localMediaStore';
import { loadNativeAuctionCamera } from '../components/camera/nativeAuctionCameraModule';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  getInfoAsync: jest.fn(),
  copyAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
  readDirectoryAsync: jest.fn(),
  deleteAsync: jest.fn(),
}));
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn(),
  SaveFormat: { JPEG: 'jpeg' },
}));
jest.mock('../components/camera/nativeAuctionCameraModule', () => ({
  loadNativeAuctionCamera: jest.fn(),
}));

const input = (sourceUri: string, index = 0) => ({
  sourceUri,
  draftId: 'draft',
  lotId: 'lot',
  slot: 'main' as const,
  index,
  name: 'capture.jpg',
  type: 'image/jpeg',
  mediaId: `media-${index}`,
});
beforeEach(() => {
  jest.resetAllMocks();
  LocalMediaStore.setOwner('owner');
  jest
    .mocked(FileSystem.getInfoAsync)
    .mockResolvedValue({
      exists: true,
      isDirectory: false,
      uri: 'file:///source.jpg',
      size: 123,
      modificationTime: 1,
    });
});

it.each([
  'file:///documents/camera-photos/photo.jpg',
  'file:///data/user/0/com.assetinsight.app/files/camera-photos/photo.jpg',
])('reuses a durable camera original without an offline copy: %s', async (uri) => {
  const media = await LocalMediaStore.importMedia(input(uri));
  expect(media).toMatchObject({ uri, mediaId: 'media-0', ownership: 'camera' });
  expect(FileSystem.copyAsync).not.toHaveBeenCalled();
});

it.each([
  'file:///documents/camera-videos/walkthrough.mp4',
  'file:///data/user/0/com.assetinsight.app/files/camera-videos/walkthrough.mp4',
  'content://media/external/video/media/720',
])('repeated offline video saves retain one durable original: %s', async uri => {
  const info = jest.fn().mockResolvedValue({ exists: true, size: 8_000_000, type: 'video/mp4' });
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera: jest.fn(), getContentUriInfo: info });
  const reference = { ...input(uri), slot: 'video' as const, name: 'walkthrough.mp4', type: 'video/mp4' };
  for (let save = 0; save < 3; save++) {
    expect(await LocalMediaStore.importMedia(reference)).toMatchObject({ uri, mediaId: 'media-0', type: 'video/mp4',
      ownership: uri.startsWith('content:') ? 'gallery' : 'camera' });
  }
  expect(FileSystem.copyAsync).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
});

it('reuses the MediaStore reference and closed native descriptor size without opening an Expo content stream', async () => {
  const getContentUriInfo = jest
    .fn()
    .mockResolvedValue({ exists: true, size: 2500, type: 'image/webp' });
  jest
    .mocked(loadNativeAuctionCamera)
    .mockResolvedValue({ openAuctionCamera: jest.fn(), getContentUriInfo });
  const uri = 'content://media/external/images/media/12';
  expect(await LocalMediaStore.importMedia(input(uri))).toMatchObject({
    uri,
    size: 2500,
    ownership: 'gallery',
  });
  expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
  expect(FileSystem.copyAsync).not.toHaveBeenCalled();
});

it('retains missing gallery references as an explicit failed import, never tries to make a duplicate', async () => {
  jest
    .mocked(loadNativeAuctionCamera)
    .mockResolvedValue({
      openAuctionCamera: jest.fn(),
      getContentUriInfo: jest.fn().mockResolvedValue({ exists: false }),
    });
  expect(
    await LocalMediaStore.importMedia(input('content://media/external/images/media/12'))
  ).toBeNull();
  expect(FileSystem.copyAsync).not.toHaveBeenCalled();
});

it('bounds concurrent metadata/import operations to four for large capture batches', async () => {
  let active = 0;
  let maximum = 0;
  jest.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    active--;
    return { exists: true, isDirectory: false, uri, size: 123, modificationTime: 1 };
  });
  const result = await Promise.all(
    Array.from({ length: 104 }, (_, index) =>
      LocalMediaStore.importMedia(input(`file:///documents/camera-photos/${index}.jpg`, index))
    )
  );
  expect(result).toHaveLength(104);
  expect(maximum).toBe(4);
  expect(FileSystem.copyAsync).not.toHaveBeenCalled();
});

it('scopes newly imported managed paths by owner without deleting another owner files', () => {
  const first = LocalMediaStore.getDraftDir('same-draft');
  LocalMediaStore.setOwner('other-owner');
  expect(LocalMediaStore.getDraftDir('same-draft')).not.toBe(first);
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
});

it('never redirects an import into the next account when the source lookup is delayed', async () => {
  let finish!: (info: any) => void;
  jest.mocked(FileSystem.getInfoAsync).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const saving = LocalMediaStore.importMedia(input('file:///cache/new-capture.jpg'));
  const rejected = expect(saving).rejects.toThrow('account changed');
  LocalMediaStore.setOwner('other-owner');
  finish({ exists: true, isDirectory: false, size: 100 });
  await rejected;
  expect(FileSystem.copyAsync).not.toHaveBeenCalled();
  expect(FileSystem.makeDirectoryAsync).not.toHaveBeenCalled();
});

it('retains the original owner path and stops thumbnail work when ownership changes during copying', async () => {
  let finishCopy!: () => void;
  let copyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    copyStarted = resolve;
  });
  jest.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri) => {
    if (uri === 'file:///cache/new-capture.jpg' || uri.endsWith('/')) {
      return {
        exists: true as const,
        isDirectory: uri.endsWith('/'),
        uri,
        size: 100,
        modificationTime: 1,
      };
    }
    return { exists: false as const, isDirectory: false, uri };
  });
  jest.mocked(FileSystem.copyAsync).mockImplementationOnce(async () => {
    copyStarted();
    await new Promise<void>((resolve) => {
      finishCopy = resolve;
    });
  });
  const saving = LocalMediaStore.importMedia(input('file:///cache/new-capture.jpg'));
  const rejected = expect(saving).rejects.toThrow('account changed');
  await started;
  LocalMediaStore.setOwner('other-owner');
  finishCopy();
  await rejected;
  expect(FileSystem.copyAsync).toHaveBeenCalledTimes(1);
  expect(jest.mocked(FileSystem.copyAsync).mock.calls[0][0].to).toContain('/owner_draft/');
  expect(jest.mocked(FileSystem.copyAsync).mock.calls[0][0].to).not.toContain('/other-owner_');
});

it('stops cleanup after a delayed directory listing changes account', async () => {
  let finish!: (files: string[]) => void;
  let listingStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    listingStarted = resolve;
  });
  jest.mocked(FileSystem.readDirectoryAsync).mockImplementationOnce(async () => {
    listingStarted();
    return new Promise<string[]>((resolve) => {
      finish = resolve;
    });
  });
  const cleaning = LocalMediaStore.cleanupOrphanedDraftFolders([]);
  const rejected = expect(cleaning).rejects.toThrow('account changed');
  await started;
  LocalMediaStore.setOwner('other-owner');
  finish(['owner_draft', 'other-owner_draft']);
  await rejected;
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
});

it('rechecks account ownership immediately before deleting a managed file', async () => {
  let finish!: (info: any) => void;
  jest.mocked(FileSystem.getInfoAsync).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const cleaning = LocalMediaStore.deleteDraftMedia('draft');
  const rejected = expect(cleaning).rejects.toThrow('account changed');
  LocalMediaStore.setOwner('other-owner');
  finish({ exists: true, isDirectory: true });
  await rejected;
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
});

it('keeps shared managed references while pruning only unreferenced files', async () => {
  const directory = LocalMediaStore.getDraftDir('draft');
  jest.mocked(FileSystem.readDirectoryAsync).mockResolvedValue(['shared.jpg', 'stale.jpg']);
  jest
    .mocked(FileSystem.getInfoAsync)
    .mockImplementation(async (uri) => ({
      exists: true,
      isDirectory: uri.endsWith('/'),
      uri,
      size: 100,
      modificationTime: 1,
    }));
  await LocalMediaStore.pruneDraftFiles('draft', [
    `${directory}shared.jpg`,
    'content://media/external/images/media/1',
  ]);
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(`${directory}stale.jpg`, {
    idempotent: true,
  });
});

it('bounds all 5000 existing-photo metadata checks, including callers that do not import media', async () => {
  let active = 0;
  let maximum = 0;
  const getContentUriInfo = jest.fn(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return { exists: true, size: 100 };
  });
  jest
    .mocked(loadNativeAuctionCamera)
    .mockResolvedValue({ openAuctionCamera: jest.fn(), getContentUriInfo });
  const infos = await Promise.all(
    Array.from({ length: 5000 }, (_, index) =>
      LocalMediaStore.getFileInfo(`content://media/external/images/media/${index}`)
    )
  );
  expect(infos).toHaveLength(5000);
  expect(maximum).toBe(4);
  expect(getContentUriInfo).toHaveBeenCalledTimes(5000);
  expect(FileSystem.copyAsync).not.toHaveBeenCalled();
});
