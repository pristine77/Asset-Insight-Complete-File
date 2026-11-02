# Salvage document exports

The full appraisal uses the same saved `buildSalvageAppraisalView` conclusions
in PDF, editable Word and Excel: every unit, value basis, reserve, salvage value,
repair line and report total. Existing single-unit snapshots with no appraisal
fields keep their established Word layout and Excel worksheets.

Word's appraisal text, tables, contents links and financial values are native
editable document elements. Only original photographs, signatures and uploaded
CV/appendix pages are images. Excel keeps all units and financial values in
native cells, with an explicit currency and per-unit value basis. Its totals
sum the displayed unit values; unknowns remain blank instead of becoming zero.

CV and PDF appendices require the `pdftoppm` executable from the operating
system's Poppler utilities (`poppler-utils` on AlmaLinux). This is a backend
runtime prerequisite, not a new npm package or environment variable. The PDF
loader validates a maximum of 30 MB and 60 pages per document, and at most 200
appendix pages. Rendering runs without a shell in a private temporary directory,
with a two-minute deadline, a 1600-pixel page bound and a 256 MB prepared
attachment limit. Failure refuses the whole generation; originals remain
available for retry. Temporary files are removed on success and failure.

Word and Excel include every uploaded page in source order, honour the source
rotation, fit the full page within the output, and retain the attachment title,
page numbering and source link. CV pages precede the ordered appendices. Stored
photos remain clean; damage marks are drawn only on export copies, in the
original per-unit photo order. No image analysis or valuation provider is called
by these exporters.
