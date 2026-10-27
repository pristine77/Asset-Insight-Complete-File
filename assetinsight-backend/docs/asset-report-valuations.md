# Asset report valuation selection

Both Asset generators save Fair Market Value (`FML`) when methods are missing,
or when the comparison table is off and its selection is empty. An explicit
empty selection with the table on remains empty. Selected methods are retained
even when the optional comparison table is off.

Existing reports saved with the table off and no methods use the FMV fallback
during file generation. Source values and historical files are not rewritten.
An explicit Save/file-generation request creates corrected files.

Word and PDF schedules size value columns for their formatted amounts, keeping
decimal digits together. Only selected methods print, and the Description
heading continues to contain the saved Title.

No new environment variables, indexes or migration are required. Deploy the
backend API and workers before generating corrected report files.
