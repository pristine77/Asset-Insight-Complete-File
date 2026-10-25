import {
  createSupportReplyClientMessageState,
  supportReplyDraftFingerprint,
  synchronizeSupportReplyClientMessageState,
} from './supportReplyIdentity';

const image = {
  localId: 'local-image-1',
  uri: 'file:///screen.png',
  fileName: 'screen.png',
  contentType: 'image/png',
  kind: 'image' as const,
  size: 128,
};

describe('support reply idempotency identity', () => {
  it('preserves the client message id for an unchanged ambiguous retry', () => {
    const createId = jest.fn(() => 'message-2');
    const fingerprint = supportReplyDraftFingerprint('Please review this.', [image]);
    const current = createSupportReplyClientMessageState(fingerprint, () => 'message-1');

    const next = synchronizeSupportReplyClientMessageState(current, fingerprint, createId);

    expect(next).toBe(current);
    expect(next.clientMessageId).toBe('message-1');
    expect(createId).not.toHaveBeenCalled();
  });

  it('rotates the client message id when reply text changes', () => {
    const current = createSupportReplyClientMessageState(
      supportReplyDraftFingerprint('Original reply', [image]),
      () => 'message-1'
    );

    const next = synchronizeSupportReplyClientMessageState(
      current,
      supportReplyDraftFingerprint('Edited reply', [image]),
      () => 'message-2'
    );

    expect(next.clientMessageId).toBe('message-2');
  });

  it('rotates for attachment selection changes but ignores upload-only state', () => {
    const originalFingerprint = supportReplyDraftFingerprint('', [image]);
    const uploadUpdatedImage = {
      ...image,
      progress: 1,
      uploaded: { id: 'remote-1' },
    };
    const uploadUpdatedFingerprint = supportReplyDraftFingerprint('', [uploadUpdatedImage]);
    const current = createSupportReplyClientMessageState(originalFingerprint, () => 'message-1');

    const afterUpload = synchronizeSupportReplyClientMessageState(
      current,
      uploadUpdatedFingerprint,
      () => 'unexpected'
    );
    const afterReplacement = synchronizeSupportReplyClientMessageState(
      afterUpload,
      supportReplyDraftFingerprint('', [{ ...image, localId: 'local-image-2' }]),
      () => 'message-2'
    );

    expect(uploadUpdatedFingerprint).toBe(originalFingerprint);
    expect(afterUpload.clientMessageId).toBe('message-1');
    expect(afterReplacement.clientMessageId).toBe('message-2');
  });
});
