# Submitted drafts and initial preview recovery

An accepted Asset or Lot Listing upload retains its server draft until a saved
preview is available. The draft is hidden while processing and becomes visible
with a failure note if initial processing stops. A usable preview retires the
unchanged submitted draft. A later user save clears the submission markers and
remains independent work.

Draft attachment uses the original upload acceptance timestamp. Delayed cleanup
cannot attach a newer save to an older report. Marking and deletion compare the
exact draft revision, media revision, content hash, timestamp and submission
identity. A changed snapshot is retained; its media is not deleted. A late
processed-session receipt also checks the current preview; a completed worker
with no usable lots does not retire the saved draft. Old client cleanup requests
also retain failed submitted drafts, even when the source-session cleanup has
started. An existing confirmed Discard action sends `intent: "discard"` and the
displayed draft's opaque `discardRevision` as `baseRevision`. Both owner DELETE
routes verify that exact snapshot before deletion and return its `draftId` with
`deleted: true`. Missing or changed versions return 409; a processing submission
remains retained. No confirmation or workflow step is added.

Failed ordinary initial previews use the existing capability read and
revision-bound `retry-preview` action. The same original upload manifest and
objects must remain available. Retry preserves the report identity, uses one
worker attempt and retains the source cleanup pin. After three explicit source
retries the user is directed to support. File generation still requires review
and submission, and duplicate lot labels still require correction.

## Sale-pending Auctioneer lots

Auctioneer may mark a Schedule A task `saleEventPending: true` before assigning
its sale event. Such an explicitly flagged task can produce its condition report
without allocating an event number. Condition-report delivery and completed-state
reconciliation do not send a replacement lot number back to Auctioneer.

The exception applies only to Auctioneer Schedule A work with no event and all
saved tasks flagged. Split lots still require an event. Retry validates the exact
linked report, owner, optional assignment, current work state and absence of a
frozen delivery. Its queued exception is bound to that work ID and checked again
before and after retained-source checks. A changed assignment or pending flag
stops analysis and retains the report for review.

The existing Incoming assignment, capture-revision and provider delivery gates
remain in effect. Local tests use synthetic provider responses; they do not
certify a live Bank/Corporate integration or send customer reports. Deploy API
and report workers together before the matching clients. No existing report is
automatically retried or regenerated.
