# Arrival photo transfers

Authenticated Arrival requests use `/api/auctioneer/arrival-photo-requests` and
`POST /api/auctioneer/arrival-photo-requests/:requestId/photos`. The provider
must implement the matching `/api/external/arrival-photo-requests` endpoints.
The list must return `{ success: true, items: [...] }`; an HTML response or an
unconfirmed JSON response is an error, not an empty queue.

The upload accepts up to 60 images, at most 20 MiB per original and 120 MiB in
one selection. Originals are staged in a private temporary directory and removed
when processing finishes or fails. There are at most two concurrent transfers
per API process. Watermarking runs sequentially, then batches contain at most five
images and 35 MiB of decoded data. No report or analysis job is created.

Every provider batch needs HTTP 201 and explicit `success: true`, with integer
`stored`, `skipped`, and `photoCount` fields. `stored + skipped` must account for
every submitted image. The reported photo count cannot be lower than the total
newly stored images already confirmed in this transfer. The request deadline
includes reading the response body.

## Retry behavior

`ArrivalPhotoTransfer` stores small transfer receipts in MongoDB. Its built-in
unique `_id` fences the authenticated user/request pair; it needs no new index or
migration. The manifest hashes ordered original image bytes, so changed filenames
do not create a new operation.

- A retry after a fully confirmed upload returns the saved receipt without
  sending any photos again.
- After a definitive refusal, confirmed earlier batches are retained and a retry
  of the same selection starts at the last checkpoint.
- A transport failure, malformed receipt, failed receipt persistence, or a process
  interruption during a send does not automatically replay bytes. The API returns
  `arrival_photos_unconfirmed`; clients must retain the selected photos. The
  auction team must check the provider request before any recovery of this state.
- A different selection cannot replace a transfer with possible external effects.
  `arrival_photos_selection_changed` directs the user to retain/retry the original
  selection. A local image preparation failure before any external write releases
  its untouched claim, allowing the user to correct the image and try again.

Do not clear uncertain receipts to make a retry succeed without checking the
provider. Batch continuation after the provider marks a request received depends
on the provider contract and must be verified against the deployed receiver.

## Capture lot identity

Ordinary Asset/Lot mixed submissions may include `capture_lot_id` and
`capture_lot_number`. Cloud draft previews derive these from the saved lot identity.
The initial analysis preserves an explicit capture label only when one group
produces exactly one output lot. The original group identity remains in
`analysis_metadata.capture_lot_identity`; expanded groups keep their independent
output labels. Assigned Auctioneer identities and reviewed Smart Upload labels
retain precedence. Duplicate initial output labels stop publication with a clear
error rather than silently renumbering or coalescing lots. Existing merged-report
ordering and existing customer reports are not rewritten.
