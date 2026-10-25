export type SupportReplyAttachmentIdentity = {
  localId: string;
  uri: string;
  fileName: string;
  contentType: string;
  kind: 'image' | 'video';
  size?: number;
  width?: number;
  height?: number;
  durationMs?: number;
};

export type SupportReplyClientMessageState = {
  fingerprint: string;
  clientMessageId: string;
};

/**
 * Represents only the user's reply intent. Upload progress and the resulting
 * remote attachment are intentionally excluded so an unchanged retry keeps
 * the same idempotency key after an ambiguous network response.
 */
export function supportReplyDraftFingerprint(
  body: string,
  attachments: readonly SupportReplyAttachmentIdentity[]
): string {
  return JSON.stringify([
    body,
    attachments.map((attachment) => [
      attachment.localId,
      attachment.uri,
      attachment.fileName,
      attachment.contentType,
      attachment.kind,
      attachment.size ?? null,
      attachment.width ?? null,
      attachment.height ?? null,
      attachment.durationMs ?? null,
    ]),
  ]);
}

export function createSupportReplyClientMessageState(
  fingerprint: string,
  createId: () => string
): SupportReplyClientMessageState {
  return { fingerprint, clientMessageId: createId() };
}

/**
 * Rotates the idempotency key when—and only when—the user's reply intent has
 * changed. Returning the current object for an identical fingerprint makes an
 * uncertain send safe to retry without creating a duplicate message.
 */
export function synchronizeSupportReplyClientMessageState(
  current: SupportReplyClientMessageState,
  fingerprint: string,
  createId: () => string
): SupportReplyClientMessageState {
  return current.fingerprint === fingerprint
    ? current
    : createSupportReplyClientMessageState(fingerprint, createId);
}
