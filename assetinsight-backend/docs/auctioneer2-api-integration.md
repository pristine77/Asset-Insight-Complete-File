# Auctioneer photo delivery

Outbound photo MIME types and filenames follow the actual JPEG, PNG, WebP,
GIF, or AVIF signature. Accepted originals at most 20 MiB retain their bytes.
Unsupported formats and larger images are converted to JPEG within the same
delivery checkpoint. HEIC originals use the existing HEIC decoder, including
deployments where Sharp lacks HEVC support. Generic binary storage metadata is
accepted only when the downloaded bytes can be identified or decoded as an
image. Conversion changes the delivery payload while retaining the source
original. A conversion failure names the photo's position and a safe format
description for support to review the frozen delivery.

Known Auctioneer photo, event, customer, description, service, and category
refusals provide an actionable message. Dynamic provider MIME strings and
unrecognized errors remain private. Retrying continues the saved delivery
checkpoints, so editing the report does not replace an existing delivery's
frozen photos or lot details.
