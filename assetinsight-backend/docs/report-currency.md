# Asset and Lot Listing currency

A report's currency is decided when the report is created, and the valuation
is produced in it: `utils/assetPrompts.ts` asks for every value in the report's
currency. A preview save never changes it (owner, 2026-10-31: "The software has
to do its valuation in the correct currency").

## How a new report's currency is chosen

1. A continued form keeps the currency already chosen.
2. A report from an Auctioneer 2.0 contract starts in that sale's currency.
   Auctioneer 2.0 sends `currency` ("CAD"/"USD") on its contracts, incoming
   tasks and events, decided as the sale's invoices are billed (a US sale is
   USD; a contract not yet on a sale goes by the currency it was written in).
   `normalizeAuctioneer2Contract` reads it, the work item's contract snapshot
   stores it, the setup returns it, and `applyCanonicalAuctioneerDetails` uses
   it when a form sends none. Older claimed work uses the currency from the
   same frozen raw contract snapshot in both setup and report creation.
3. Otherwise the inspection location decides: the country named in it, then a
   Canadian postal code or a US state code with its ZIP, then a province/state
   name or a ", SK" / ", ND" style code (`currencyForReportLocation`, the same
   rules on the website and in the phone app). Reverse geocoding of the
   device's position supplies the country when no address is typed. An
   address that points both ways chooses nothing, and the user picks.
4. The browser's or phone's language is never used: most Canadian PCs report
   "en-US".

The dropdown on the creation form is the final authority before submission:
a manual selection survives late location responses.

## After creation

The preview shows the report's currency and does not change it.
`utils/reportCurrencyLock.ts`:

- `previewWithReportCurrency` fills the currency into every preview GET.
- Raw owner, assigned-approval, upload and draft submission requests are checked
  before normalization or money/workflow changes. A different or invalid currency,
  or a new pending conversion receipt from an older open page, receives HTTP 409
  `REPORT_CURRENCY_LOCKED` with instructions to reload and review unsaved edits.
- `keepSavedReportCurrency` repeats validation at persistence. Same-currency edits,
  explicit zero values, missing legacy currency fields and old read markers work.
  An identical receipt already stored on the report is historical provenance and
  may be echoed by an older client on an ordinary same-currency save.
- `syncAssetPreviewDataToRoot` no longer copies a preview currency onto the
  report.

## Removed: preview currency conversion (2026-10-31)

The preview's "Convert amounts" conversion (exchange rate looked up through the
OpenAI web-search tool, signed conversion receipts) was removed at the owner's
request. Its endpoints `POST /api/asset/:id/preview/currency-conversion`,
`/api/lot-listing/:id/preview/currency-conversion` and
`/api/reports/assigned-approvals/:id/preview/currency-conversion` no longer
exist. Reports converted while it was live keep their converted amounts and
currency. GET responses omit `currency_conversion` and `_currency_base_revision`
without changing storage. Accepted ordinary saves strip these retired transport
fields; pending conversions are rejected before any values can be relabelled.
Existing reports are not automatically converted or regenerated.
