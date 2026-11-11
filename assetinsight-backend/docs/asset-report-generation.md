# Evaluator values in appraisal files

When a lot has entered Proposal Valuation figures, appraisal Word/PDF files use
the arithmetic mean of its nonblank active evaluator cells. Explicit zero counts;
a wholly blank row retains its saved AI estimate and any independent method
overrides. Active linked columns follow the same owner/assignment reconciliation
as the Proposal Valuation screen, including ownership transfers; text-only legacy
columns remain eligible.

`assetAppraisalValueProjectionService.ts` creates only a rendering copy. Stored
AI estimates, the blue Asset Insight column, evaluator inputs, source totals,
currency, fee rules, media and parent reports are unchanged. Output amounts round
at the saved currency's minor units, and totals sum the rows actually emitted in
Schedule A. Selected liquidation/trade-in methods retain their saved percentages;
missing rates fail clearly instead of inventing a percentage. A parent evaluator
total cannot be allocated across multiple catalogue children without individual
item appraisal values. Existing revision/token publication fences still apply.

The auction-import Excel layout retains its independent Opening Bid and Bid
Increment inputs and links the corresponding Schedule A PDF. The separate Proposal
Valuation workbook continues to show the original AI and entered evaluator columns.
This projection makes no image-analysis or currency-lookup requests. Existing
files change only after the ordinary guarded file-generation workflow runs.

## Proposal bid percentages

The File Summary saves bid percentages on each proposal. New uncapped guarantees
and cash offers default to 78.5% and 90% of auction value respectively. Auction
value is the sum of the evaluator averages, equivalent to gross less the actual
per-lot buyer premiums. Older saved offers retain their gross basis independently
until the user enters a percentage or chooses Use auction value for that offer.
Excel also preserves each saved gross quote until its net-rate cell is filled.
In the capped scenario, NMG uses 100%
of average less costs and threshold by default, and cash uses 100% of average.
Commission defaults to 100% of the existing premium-based commission amount in
either scenario. An explicit zero is valid. The workbook uses the same rates.
