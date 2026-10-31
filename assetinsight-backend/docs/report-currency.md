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
   it when a form sends none.
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
- `keepSavedReportCurrency` runs on every Asset and Lot Listing preview save
  (owner, assigned-approval and draft paths): the preview's currency is reset
  to the one the report was valued in, whatever the request carried.
- `syncAssetPreviewDataToRoot` no longer copies a preview currency onto the
  report.

## Removed: preview currency conversion (2026-10-31)

The preview's "Convert amounts" conversion (exchange rate looked up through the
OpenAI web-search tool, signed conversion receipts) was removed at the owner's
request. Its endpoints `POST /api/asset/:id/preview/currency-conversion`,
`/api/lot-listing/:id/preview/currency-conversion` and
`/api/reports/assigned-approvals/:id/preview/currency-conversion` no longer
exist. Reports converted while it was live keep their converted amounts and
currency; the leftover `currency_conversion` and `_currency_base_revision`
fields are stripped from incoming saves and never written again.
