# Asset valuation selection

Selected valuation methods are independent of the optional comparison table. Both Asset submission paths retain the user's methods when that table is off. Initial analysis calculates the selected liquidation/trade percentages through the existing valuation service; FMV-only submissions with the table off skip comparison analysis.

Preview displays only selected methods, calculated from each lot's editable base FMV and the saved method percentage. Changing methods retains saved percentages. A newly selected liquidation/trade method without a saved percentage requires a confirmed, nonnegative percentage before Save; zero is valid. Save preserves the full report, including lots on other pages, and does not re-read photos.

Older reports with an empty method list and the table off retain the historical FMV fallback. Their original liquidation selection or percentage cannot be recovered from an empty payload; use Preview to select the intended method and confirm its percentage. An explicit empty choice with the table on remains empty. Unselected historical calculation records never restore themselves as selected methods.
