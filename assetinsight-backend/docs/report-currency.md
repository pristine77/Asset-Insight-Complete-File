# Asset and Lot Listing currency

Creation forms detect currency from the inspection location, not the device's
language. The dropdown is the final authority: manual selections and restored
draft/continuation values survive late location responses. A readable web
location with an unknown currency requires an explicit choice. Offline/denied
location access retains the existing manual fallback.

## Preview conversion

An editable preview uses **Convert amounts**, followed by its existing **Save**.
Selecting a dropdown option alone never relabels monetary values. Conversion
is a read-only calculation until Save; it does not enqueue image analysis,
regenerate files, approve, release or mutate a customer report by itself.
Save retains the existing artifact-generation and approval workflow.

The authenticated endpoints are:

- `POST /api/asset/:id/preview/currency-conversion`
- `POST /api/lot-listing/:id/preview/currency-conversion`
- `POST /api/reports/assigned-approvals/:id/preview/currency-conversion`

Body: `{ targetCurrency, preview_data }`. Send the entire current edited
snapshot, including the opaque `_currency_base_revision` provided by its most
recent preview GET. The response is `{ data: { preview_data, quote } }`.
Apply the returned snapshot intact, including `currency_conversion`; do not
construct or edit its token or monetary basis. Pass it to the ordinary Save.
The read marker is stripped before persistence and generation snapshots.

`quote` contains `fromCurrency`, `toCurrency`, `rate`, `asOf`, `sourceUrl`,
`sourceTitle` and `quotedAt`. Display the date and clickable source to users.
The backend uses the existing centralized OpenAI connection and the
[Responses web-search tool](https://developers.openai.com/api/docs/guides/tools-web-search)
to look up only the currency pair and current date. Report content, photographs
and customer details are not sent to that lookup. A completed search, consulted
HTTPS source from the allowlist, positive finite rate and recent observation
date are required. Failed or unsupported lookups leave the preview untouched;
there is no invented fallback rate.

## Financial and concurrency rules

- Decimal/rational arithmetic applies the rate to explicit financial fields,
  using the target currency's minor units. Nulls and unknowns stay unknown.
  Ambiguous monetary strings are rejected instead of guessed.
- Derived totals sum converted, individually rounded lots. Independent manual
  financial overrides are converted as overrides. Valuation percentages stay
  percentages. Existing Proposal Valuation fee formulas and caps still apply.
- Signed monetary bases prevent successive pre-Save currency changes from
  compounding rounding drift. New local monetary edits are rebased deliberately.
- The rate is a stable, dated intent for a long editing session. A timer does
  not force users to discard work. Its signature, report identity, server
  snapshot, update stamp and Proposal Valuation revision are verified at Save.
  Another tab's edit or reassignment requires a fresh preview/conversion.
- Protected Asset saves convert the authoritative evaluator sheet under the
  existing revision guard. They ignore client attempts to supply its values.
  Root and preview currencies/financial values are saved together.
- Merged reports convert the full derived report; parent reports stay intact.
- Monetary conversion never rewrites specifications, hours, quantities, IDs,
  descriptions or historical external statistics embedded in prose.
- Client contexts fence pending responses by report, editing state and account
  session, and serialize conversion with Save/upload actions.

The optional Lot preview receipt uses its existing document schema. There are
no new collections, indexes, environment variables or migrations. Deploy the
backend before the website and a new mobile build. Admin's generic preview
remains read-only and displays the saved report values.
