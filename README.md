# Bank Reconciliation Assistant

**Project status: Complete.**

A professional local-first tool for accounting students, accountants, and small businesses to compare a bank statement CSV with an internal ledger CSV. It identifies clear one-to-one matches, keeps uncertain candidates for review, highlights data-quality issues, and exports the current reconciliation.

Bank statements and ledgers often differ because of posting delays, reused amounts, missing entries, or inconsistent descriptions. This tool makes those differences visible with deterministic, inspectable rules. It assists reconciliation and **does not replace accounting review or establish that the books are correct**.

## Workflow and features

1. Upload one Bank CSV and one Ledger CSV, or try the downloadable bilingual samples.
2. Inspect detected headers and map each file separately.
3. Choose the date format and confirm the amount direction.
4. Inspect previews containing the unchanged original cell values.
5. Run reconciliation using exact cent amounts and a three-day posting window.
6. Review automatic matches, candidate suggestions, unpaired rows, and data issues.
7. Confirm or reject suggestions, manually pair transactions, or undo a match.
8. Download the full reconciliation, unmatched Bank/Ledger records, and summary CSVs.

The responsive workspace provides search by description/reference, date filters, row inspection, pagination, sample downloads, and Start Over. View filters affect neither totals nor reports. There are no accounts, database, AI, bank connections, or paid APIs.

## Run locally

Node.js 20.9+ and npm are required. No environment variables or credentials are needed.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

```bash
npm test
npm run build
npm run lint
npm run typecheck
```

Stack: Next.js App Router, React, TypeScript, and PapaParse. `next.config.ts` uses `output: "export"`, so `npm run build` produces static assets in `out/`. File processing, normalization, matching, review state, and CSV creation all run in the browser; no API routes or server actions handle financial data.

## Supported CSV structures

Use comma-separated UTF-8 CSV with one header row. A UTF-8 BOM is supported. Codes/references retain leading zeros because all uploaded cells are parsed as strings. Quoted commas, double quotes, embedded newlines, Arabic descriptions, blank records, and ragged rows are handled without silently modifying source values.

Both files require **Date** and either **Amount** or separate **Debit/Credit** columns. Description and Reference/Transaction ID are optional. Ledger Account/Category is also optional. Unknown or ambiguous headers require manual mapping; each selected field must use a different column. A running balance column is not a transaction amount.

### Signed amounts

```csv
Date,Amount,Description,Reference
2026-09-01,2500.00,مبيعات نقاط البيع,POS-101
2026-09-02,-900.00,سداد مورد,SUP-202
```

By default positive means money in and negative means money out, for both files. If your export uses the opposite convention, choose **Positive amount represents: Money out** for that file. All matching uses a consistent signed inflow-positive/outflow-negative representation.

### Separate debit and credit

A typical bank export uses debit for withdrawals and credit for deposits:

```csv
Date,Debit,Credit,Description,Reference
2026-09-01,,2500.00,مبيعات نقاط البيع,POS-101
2026-09-02,900.00,,سداد مورد,SUP-202
```

A cash ledger typically uses debit for money in and credit for money out:

```csv
Date,Debit,Credit,Description,Reference
2026-09-01,2500.00,,مبيعات نقاط البيع,POS-101
2026-09-02,,900.00,سداد مورد,SUP-202
```

Defaults reflect these conventions: Bank debit = outflow; Ledger debit = inflow. Confirm the **Debit represents** selection against your export. Leave the unused side blank. Both-filled rows, including explicit zeros, and negative debit/credit values are ambiguous and excluded from matching/totals until the source is corrected. No row is deleted or automatically corrected.

### Dates and amounts

- Default dates: strict `YYYY-MM-DD`. Explicit `DD/MM/YYYY` or `MM/DD/YYYY` also allow consistent dash separators. Impossible dates are errors; ambiguous formats are never guessed. Comparisons use whole UTC calendar days, without daylight-saving or local-time offsets.
- Monetary arithmetic uses `BigInt` integer cents. Decimal strings round **half away from zero**: `1.005` becomes `1.01`, `-1.005` becomes `-1.01`. More than two fractional digits produce a warning even if extra digits are zero. The original string stays visible.
- Valid examples: `1234.56`, `"1,234.56"`, `(1234.56)`, and `١٬٢٣٤٫٥٦`. Grouping commas must be properly placed and quoted in CSV. Arabic/extended Arabic digits and Arabic decimal/grouping separators are supported.
- Currency symbols, scientific notation, malformed grouping, decimal commas, and nonnumeric text are rejected. Matching requires exactly equal signed cents after normalization; there is no amount tolerance.

## Transparent matching and confidence

Candidates must have valid dates and amounts, the **same signed normalized amount**, and dates no more than **three calendar days apart**, inclusive. Amount differences and opposite signs cannot match, even when descriptions or references agree.

Signals are prioritized as follows:

1. Exact signed amount, required for every candidate.
2. Exact normalized nonempty reference. It is a strong signal only when unique in **both complete files**; repeated references are flagged and are not trusted by themselves.
3. Normalized description similarity: Unicode character-bigram Dice similarity, preserving Arabic letters. Case, surrounding/repeated whitespace, and punctuation differences are normalized. A similarity of at least `0.8` is strong evidence if nonempty references do not conflict.
4. Posting-date proximity helps rank candidates; a closer date alone does not resolve ambiguity.

An automatic match requires **mutual uniqueness of the strongest signal**: the Bank and Ledger row must each identify the other as their sole strongest high-confidence candidate. Unique references outrank description-only alternatives. Two strong description alternatives remain suggestions even if one date is closer. Amount/date-only candidates always need review.

High/Possible confidence labels describe deterministic signal strength, not a statistical probability or accounting certification. Ranking and reasoning remain visible. A candidate can show a strong signal while staying a suggestion because the overall choice is ambiguous.

Automatic decisions occur only when **Run Reconciliation** is clicked, using the complete original candidate graph. Confirming, rejecting, or undoing never silently converts remaining candidates into new automatic matches.

## Manual review and data issues

- **Confirm** a current suggestion: establishes a reviewed one-to-one pair and removes other candidates using either row.
- **Reject** a suggestion: removes that candidate edge while retaining both source transactions and any other candidates.
- **Match manually**: choose two unpaired rows with valid dates and identical signed amounts. This explicit review may override the three-day window; the reason records the date difference. It cannot override unequal amounts or invalid data.
- **Undo** any automatic, confirmed, or manual pair: returns both transactions to the available pool. They return to suggestions only when still within the normal candidate window.
- Each transaction belongs to at most one confirmed pair. Matching controls and engine checks both enforce this rule.

Data-quality findings separately identify missing/invalid dates, missing/invalid amounts, blank rows, malformed row widths, ambiguous debit/credit rows, rounding, whitespace, duplicate transactions, and repeated references. Duplicate detection compares normalized date, amount, description, reference, and Ledger account; identical invalid raw records are also flagged. Duplicates are warnings because legitimate repeated transactions can exist. Every nonblank record is retained.

Invalid records stay visible and unpaired. Blank records are reported but excluded from transaction counts. Known amounts from invalid-date rows still contribute to totals; missing/invalid/ambiguous amounts do not, and totals/difference are explicitly marked **partial**.

## Summary meanings

- Bank/Ledger totals sum signed normalized amounts from every nonblank record with a usable amount, including duplicates.
- Matched count counts confirmed pairs. Matched amount sums the Bank side of each pair **once**, as a signed net flow.
- Suggested count counts candidate pairs; several may refer to the same transaction.
- Unmatched counts/amounts include **all unpaired transactions**, including those awaiting suggestion review.
- **Reconciliation Difference = Bank signed total − Ledger signed total = unreconciled Bank − unreconciled Ledger.**

A zero difference can hide offsetting unmatched transactions. This is a comparison of transaction movements, not a formal reconciliation of opening/closing bank balances. Review outstanding items and all data-quality findings.

## Reports and Arabic

Exports use UTF-8 with a BOM for Arabic in Excel, CRLF record endings, and proper escaping of commas, quotes, and embedded newlines. Calculated amounts export as ungrouped two-decimal numeric text.

- **Reconciliation report:** the requested side-by-side Bank/Ledger fields with statuses `AUTO MATCHED`, `CONFIRMED`, `MANUAL MATCHED`, `SUGGESTED`, `BANK UNMATCHED`, or `LEDGER UNMATCHED` and deterministic reasons. Candidate rows are proposals, never extra confirmed matches. Unpaired rows with suggestions are represented by candidate rows here.
- **Unmatched Bank/Ledger:** every currently unpaired record, including suggestion participants. Invalid raw date/amount text remains visible; valid amounts/dates use the selected normalized interpretation.
- **Summary:** all counts, signed totals, unreconciled amounts, difference, and amount-completeness flags.

Formula-like uploaded text starting with `=`, `+`, `-`, `@` (including after spaces), or a dangerous leading tab/newline/carriage return receives an apostrophe prefix in exported **text cells**. Calculated monetary cells remain numeric. This protects spreadsheet imports without mutating source data. Original values remain inspectable in the UI.

Arabic survives parsing, matching, display, and export, including تحويل بنكي، سداد مورد، إيداع نقدي، رسوم بنكية، تحويل راتب، and مبيعات نقاط البيع. Description normalization never strips Arabic letters or diacritics.

## Samples and automated verification

`public/sample-bank.csv` and `public/sample-ledger.csv` demonstrate four clear auto matches, eight ambiguous candidate pairs, posting delays, distinct reference/description signals, duplicate records/references on both sides, unmatched fees/cheques, and Arabic descriptions. Initial totals are Bank `2210.00`, Ledger `2170.00`, Difference `40.00`.

`tests/fixtures/manifest.json` documents **20 paired CSV scenarios**, including perfect reconciliation, ±1/3-day posting, outside-window entries, unrelated same amounts, multiple candidates, references, similar descriptions, amount mismatches, duplicate records, missing/invalid fields, Arabic, quoted multiline descriptions, manual matching, undo, one-to-one protection, debit/credit and signed/rounded values. Automated suites also cover CSV/resource guards, confidence boundaries, exact huge totals, review actions, CSV exports/formula protection, and immutable inputs.

## Privacy

All financial data and review state remain in browser memory. No financial data is uploaded, persisted to browser storage, logged to an external service, or sent to analytics. No database, cloud storage, telemetry SDK, external fonts, or external API is used. Refreshing or Start Over clears the current session; download reports before closing. Source files on disk are never modified.

## Known limitations

- UTF-8 comma-separated CSV only: maximum **5 MB per file, 10,000 records per file, 100 columns, and 10,000 characters per cell**.
- Matching stops with a clear error above **100,000 candidate pairs**; split heavily ambiguous exports into smaller date/account batches.
- One-to-one transaction matching only. Split payments, grouped deposits, net fees, currency conversion, and one-to-many/many-to-many matching are outside scope.
- Use one currency with two-decimal minor units. Rounding can make source amounts with differing precision equal; review the rounding warnings.
- No opening/closing balance calculation, balance-only statements, aggregate-footer detection, bookkeeping entries, audit assurance, or automatic correction.
- Description similarity is a deterministic heuristic; review all proposals and even automatic matches before relying on them.
- No saved sessions: data, rejection choices, and manual review state reset on refresh.
