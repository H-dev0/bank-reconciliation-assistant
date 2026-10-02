import assert from "node:assert/strict";
import test from "node:test";
import { decodeCsvBytes, encodeCsv, MAX_CELL_LENGTH, MAX_COLUMNS, MAX_FILE_BYTES, MAX_ROWS, parseCsv } from "../src/lib/csv";
import { mappingProblems, suggestMapping } from "../src/lib/mapping";
import { formatAmount, parseAmount } from "../src/lib/money";
import { buildDataset, normalizeDate, normalizeDescription, normalizeReference } from "../src/lib/normalize";
import type { Mapping } from "../src/lib/types";

const cents = (value: string) => BigInt(value);

for (const [input, expected, rounded] of [
  ["1.005", "101", true], ["-1.005", "-101", true], ["(1.005)", "-101", true],
  ["0.004", "0", true], ["-0.004", "0", true], ["0.005", "1", true],
  ["9.999", "1000", true], ["-9.999", "-1000", true], ["1.0000", "100", true],
  ["1234", "123400", false], ["1.2", "120", false], ["+1.23", "123", false],
  [" 1,234.56 ", "123456", false], ["(١٬٢٣٤٫٥٦)", "-123456", false],
  ["-۱۲٫۳۴", "-1234", false], ["9007199254740993.005", "900719925474099301", true],
] as const) {
  test(`amount normalization: ${input}`, () => {
    assert.deepEqual(parseAmount(input), { kind: "valid", cents: cents(expected), rounded });
  });
}

test("invalid amounts are rejected without partially reading them", () => {
  for (const input of ["$10.00", "10 SAR", "1e3", "1,25", "12,34,567", "1,234,56", "1.2.3", "(-1)", "--1", "10.", "NaN", "Infinity", "10 00", "(1", "1)"]) {
    assert.equal(parseAmount(input).kind, "invalid", input);
  }
  assert.deepEqual(parseAmount(" \t "), { kind: "empty" });
});

test("formatted amounts are exact, fixed precision, and ungrouped", () => {
  assert.equal(formatAmount(cents("900719925474099301")), "9007199254740993.01");
  assert.equal(formatAmount(cents("-1000")), "-10.00");
  assert.equal(formatAmount(cents("0")), "0.00");
  assert.equal(formatAmount(cents("1")), "0.01");
});

test("CSV retains raw strings, multiline fields, ragged records, and actual blank records", () => {
  const data = parseCsv('\uFEFFDate,Description,Amount\n2026-10-01,"Supplier, ""A""\nالمورد",10.25\n\n  , , \n2026-10-02,tail\n\n', "input.csv");
  assert.deepEqual(data.headers, ["Date", "Description", "Amount"]);
  assert.equal(data.filename, "input.csv");
  assert.equal(data.rows.length, 5);
  assert.deepEqual(data.rows.map(({ row }) => row), [2, 3, 4, 5, 6]);
  assert.equal(data.rows[0].cells[1], 'Supplier, "A"\nالمورد');
  assert.equal(data.rows[0].cells[2], "10.25");
  assert.deepEqual(data.rows[1].cells, [""]);
  assert.deepEqual(data.rows[2].cells, ["  ", " ", " "]);
  assert.deepEqual(data.rows[3].cells, ["2026-10-02", "tail"]);
  assert.deepEqual(data.rows[4].cells, [""]);
});

test("CSV export includes a BOM and round trips quotes, Arabic, commas, and newlines", () => {
  const rows = [["Date", "Description", "Amount"], ["2026-10-02", 'تحويل, "المورد"\nفرع الرياض', "100.00"]];
  const output = encodeCsv(rows);
  assert.equal(output[0], "\uFEFF");
  assert.ok(output.endsWith("\r\n"));
  const parsed = parseCsv(output, "report.csv");
  assert.deepEqual(parsed.headers, rows[0]);
  assert.deepEqual(parsed.rows[0].cells, rows[1]);
});

test("UTF-8 bytes are decoded strictly", () => {
  const encoded = new TextEncoder().encode("التاريخ,المبلغ\n٢٠٢٦-١٠-٠٢,١٢٫٥٠");
  assert.ok(decodeCsvBytes(encoded.buffer).includes("التاريخ"));
  assert.throws(() => decodeCsvBytes(new Uint8Array([0xc3, 0x28]).buffer), /UTF-8/);
});

test("CSV rejects empty input, missing data, one-column delimiters, and unmatched quotes", () => {
  assert.throws(() => parseCsv(" \n", "empty.csv"), /empty/);
  assert.throws(() => parseCsv("Date,Amount\n", "headers.csv"), /no data/);
  assert.throws(() => parseCsv("Date;Amount\n2026-10-02;1", "semicolon.csv"), /at least two/);
  assert.throws(() => parseCsv('Date,Amount\n2026-10-02,"10.00', "quotes.csv"), /Cannot parse CSV/);
});

test("CSV byte, record, column, and cell bounds are enforced", () => {
  assert.throws(() => parseCsv("a".repeat(MAX_FILE_BYTES + 1), "large.csv"), /5 MB/);
  assert.equal(parseCsv("Date,Amount" + "\n2026-10-02,1".repeat(MAX_ROWS), "rows.csv").rows.length, MAX_ROWS);
  assert.throws(() => parseCsv("Date,Amount" + "\n2026-10-02,1".repeat(MAX_ROWS + 1), "rows.csv"), /10,000 data/);
  const headers = Array.from({ length: MAX_COLUMNS }, (_, index) => `Column ${index}`);
  assert.equal(parseCsv(headers.join(",") + "\n" + headers.join(","), "wide.csv").headers.length, MAX_COLUMNS);
  assert.throws(() => parseCsv([...headers, "extra"].join(",") + "\n1,2", "wide.csv"), /100/);
  assert.equal(parseCsv("Date,Amount\n" + "a".repeat(MAX_CELL_LENGTH) + ",1", "cell.csv").rows[0].cells[0].length, MAX_CELL_LENGTH);
  assert.throws(() => parseCsv("Date,Amount\n" + "a".repeat(MAX_CELL_LENGTH + 1) + ",1", "cell.csv"), /10,000 characters/);
});

test("mapping detects English and Arabic fields with explicit ISO and sign defaults", () => {
  const bank = suggestMapping(["التاريخ", "البيان", "رقم المرجع", "رقم الحساب", "المبلغ"], "bank");
  assert.deepEqual(bank, { date: 0, description: 1, reference: 2, account: -1, dateFormat: "iso", format: "signed", amount: 4, sign: 1 });
  assert.deepEqual(mappingProblems(["التاريخ", "البيان", "رقم المرجع", "رقم الحساب", "المبلغ"], bank), []);
  const headers = ["Date", "Description", "Withdrawal", "Deposit"];
  const bankDc = suggestMapping(headers, "bank");
  const ledgerDc = suggestMapping(headers, "ledger");
  assert.equal(bankDc.format, "debit-credit");
  assert.equal(bankDc.sign, -1);
  assert.equal(ledgerDc.sign, 1);
  assert.deepEqual(mappingProblems(headers, bankDc), []);
});

test("unknown and ambiguous headers require manual mapping; running balance is not an amount alias", () => {
  const ambiguous = suggestMapping(["Date", "Transaction Date", "Amount", "Signed Amount"], "bank");
  assert.equal(ambiguous.date, -1);
  assert.equal(ambiguous.format === "signed" && ambiguous.amount, -1);
  assert.equal(mappingProblems(["Date", "Transaction Date", "Amount", "Signed Amount"], ambiguous).length, 2);
  const runningBalance = suggestMapping(["Date", "Balance"], "bank");
  assert.equal(runningBalance.format === "signed" && runningBalance.amount, -1);
  const forced = suggestMapping(["Date", "Amount", "Debit", "Credit"], "bank", "debit-credit");
  assert.equal(forced.format, "debit-credit");
  assert.equal(forced.sign, -1);
  const manual: Mapping = { format: "signed", date: 0, amount: 1, description: -1, reference: -1, account: -1, dateFormat: "dmy", sign: -1 };
  assert.deepEqual(mappingProblems(["Posted On", "Movement"], manual), []);
});

test("mapping validates distinct active columns, optional indices, dates, and signs", () => {
  const headers = ["Date", "Amount"];
  const valid = suggestMapping(headers, "ledger");
  assert.deepEqual(mappingProblems(headers, valid), []);
  assert.ok(mappingProblems(headers, { ...valid, reference: 0 }).some((problem) => problem.includes("different")));
  assert.ok(mappingProblems(headers, { ...valid, reference: -2 }).some((problem) => problem.includes("Reference")));
  assert.ok(mappingProblems(headers, { ...valid, dateFormat: "guess" } as unknown as Mapping).some((problem) => problem.includes("ISO")));
  assert.ok(mappingProblems(headers, { ...valid, sign: 0 } as unknown as Mapping).some((problem) => problem.includes("sign")));
});

test("ISO dates are strict calendar dates including leap years and early years", () => {
  assert.equal(normalizeDate("2024-02-29", "iso")?.date, "2024-02-29");
  assert.equal(normalizeDate("2000-02-29", "iso")?.date, "2000-02-29");
  assert.equal(normalizeDate("0099-12-31", "iso")?.date, "0099-12-31");
  for (const input of ["1900-02-29", "2026-02-29", "2026-04-31", "2026-13-01", "2026-01-00", "0000-01-01", "2026-2-1", "2026-10-02T00:00:00Z", "02/10/2026", "2026/10/02"]) {
    assert.equal(normalizeDate(input, "iso"), null, input);
  }
});

test("DMY and MDY are explicit; Arabic digits and consistent separators are accepted", () => {
  assert.equal(normalizeDate("03/04/2026", "dmy")?.date, "2026-04-03");
  assert.equal(normalizeDate("03/04/2026", "mdy")?.date, "2026-03-04");
  assert.equal(normalizeDate("٣/٤/٢٠٢٦", "dmy")?.date, "2026-04-03");
  assert.equal(normalizeDate(" ٠٢-١٠-٢٠٢٦ ", "dmy")?.date, "2026-10-02");
  assert.equal(normalizeDate("31/12/2026", "mdy"), null);
  assert.equal(normalizeDate("12/31/2026", "dmy"), null);
  assert.equal(normalizeDate("03/04-2026", "dmy"), null);
  assert.equal(normalizeDate("2026-10-02", "dmy"), null);
  const first = normalizeDate("2026-03-08", "iso");
  const second = normalizeDate("2026-03-09", "iso");
  assert.equal(second!.day - first!.day, 1);
});

test("description normalization preserves Arabic letters and reference normalization preserves ID punctuation", () => {
  assert.equal(normalizeDescription("  سداد،   الموردين (الرياض)  "), "سداد الموردين الرياض");
  assert.equal(normalizeDescription("Bank—TRANSFER, Fee."), "bank transfer fee");
  assert.equal(normalizeDescription("ＡＣＭＥ / Bank"), "acme bank");
  assert.equal(normalizeReference("  INV-001   / A.2  "), "inv-001 / a.2");
  assert.notEqual(normalizeReference("INV-001"), normalizeReference("INV001"));
  assert.equal(normalizeReference(" مرجع/أ١ "), "مرجع/أ١");
});

test("dataset keeps immutable source values and warns every normalized duplicate and repeated reference", () => {
  const source = parseCsv('Date,Description,Reference,Account,Amount\n2026-10-01,Transfer, INV-1 ,Cash,"1,000.005"\n2026-10-01,transfer.,inv-1,cash,1000.005\n', "raw.csv");
  const snapshot = JSON.stringify(source);
  for (const row of source.rows) { Object.freeze(row.cells); Object.freeze(row); }
  Object.freeze(source.headers); Object.freeze(source.rows); Object.freeze(source);
  const mapping = suggestMapping(source.headers, "bank");
  const dataset = buildDataset(source, mapping, "bank");
  assert.equal(JSON.stringify(source), snapshot);
  assert.equal(dataset.source, source);
  assert.notEqual(dataset.mapping, mapping);
  assert.deepEqual(dataset.transactions.map(({ id }) => id), ["bank:2", "bank:3"]);
  assert.equal(dataset.transactions[0].rawAmount, "1,000.005");
  assert.equal(dataset.transactions[0].reference, " INV-1 ");
  assert.equal(dataset.transactions[0].amount, cents("100001"));
  assert.equal(dataset.issues.filter(({ issueType }) => issueType === "rounded-amount").length, 2);
  assert.equal(dataset.issues.filter(({ issueType }) => issueType === "duplicate-transaction").length, 2);
  assert.equal(dataset.issues.filter(({ issueType }) => issueType === "repeated-reference").length, 2);
  assert.notEqual(dataset.transactions[0].cells, source.rows[0].cells);
  dataset.transactions[0].cells[0] = "changed copy";
  assert.equal(source.rows[0].cells[0], "2026-10-01");
});

test("invalid and missing date/amount records stay reviewable; blank records are excluded and reported", () => {
  const source = parseCsv("Date,Amount\n2026-02-30,10\n2026-10-02,bad\n,20\n2026-10-02,\n\n2026-10-03,1,extra\n", "errors.csv");
  const dataset = buildDataset(source, suggestMapping(source.headers, "bank"), "bank");
  assert.deepEqual(dataset.transactions.map(({ row }) => row), [2, 3, 4, 5, 7]);
  assert.equal(dataset.transactions[0].date, null);
  assert.equal(dataset.transactions[0].amount, cents("1000"));
  assert.equal(dataset.transactions[1].amount, null);
  assert.ok(dataset.issues.some(({ issueType, row }) => issueType === "missing-date" && row === 4));
  assert.ok(dataset.issues.some(({ issueType, row }) => issueType === "missing-amount" && row === 5));
  assert.ok(dataset.issues.some(({ issueType, row }) => issueType === "empty-row" && row === 6));
  assert.ok(dataset.issues.some(({ issueType, row }) => issueType === "row-width" && row === 7));
});

test("debit/credit orientation is side-specific and ambiguous or negative values are excluded", () => {
  const source = parseCsv("Date,Description,Debit,Credit\n2026-10-02,Outflow,10,\n2026-10-02,Inflow,,20\n2026-10-02,Both,10,0\n2026-10-02,Tiny negative,-0.004,\n2026-10-02,Negative credit,,(2.00)\n2026-10-02,Missing,,\n2026-10-02,Invalid,bad,\n2026-10-02,Zero,0,\n", "dc.csv");
  const bankMapping = suggestMapping(source.headers, "bank");
  const bank = buildDataset(source, bankMapping, "bank");
  assert.deepEqual(bank.transactions.map(({ amount }) => amount), [cents("-1000"), cents("2000"), null, null, null, null, null, cents("0")]);
  assert.equal(bank.transactions[2].rawAmount, "Debit: 10; Credit: 0");
  assert.ok(bank.issues.some(({ issueType, row }) => issueType === "both-debit-and-credit" && row === 4));
  assert.equal(bank.issues.filter(({ issueType }) => issueType === "negative-debit-credit").length, 2);
  const ledger = buildDataset(source, suggestMapping(source.headers, "ledger"), "ledger");
  assert.deepEqual(ledger.transactions.slice(0, 2).map(({ amount }) => amount), [cents("1000"), cents("-2000")]);
  const flipped = buildDataset(source, { ...bankMapping, sign: 1 }, "bank");
  assert.deepEqual(flipped.transactions.slice(0, 2).map(({ amount }) => amount), [cents("1000"), cents("-2000")]);
});

test("signed mapping can explicitly reverse direction without changing source cells", () => {
  const source = parseCsv("Date,Amount\n2026-10-02,10\n", "signed.csv");
  const dataset = buildDataset(source, { ...suggestMapping(source.headers, "ledger"), sign: -1 }, "ledger");
  assert.equal(dataset.transactions[0].amount, cents("-1000"));
  assert.equal(dataset.transactions[0].rawAmount, "10");
  assert.equal(source.rows[0].cells[1], "10");
});

test("invalid duplicate rows use exact raw fingerprints and every repeated reference is reported", () => {
  const source = parseCsv("Date,Description,Reference,Amount\nbad,Same,,bad\nbad,Same,,bad\nalso bad,Same,,bad\n2026-10-02,One,REF-1,10\n2026-10-03,Two,ref-1,20\n", "duplicates.csv");
  const dataset = buildDataset(source, suggestMapping(source.headers, "ledger"), "ledger");
  assert.equal(dataset.transactions.length, 5);
  assert.deepEqual(dataset.issues.filter(({ issueType }) => issueType === "duplicate-transaction").map(({ row }) => row), [2, 3]);
  assert.deepEqual(dataset.issues.filter(({ issueType }) => issueType === "repeated-reference").map(({ row }) => row), [5, 6]);
});

test("dataset building refuses an invalid mapping", () => {
  const source = parseCsv("Date,Amount\n2026-10-02,10", "bad-map.csv");
  const mapping = suggestMapping(source.headers, "bank");
  assert.throws(() => buildDataset(source, { ...mapping, date: -1 }, "bank"), /Date/);
  assert.throws(() => buildDataset(source, { ...mapping, description: 0 }, "bank"), /different/);
});


test("common transaction ID and category columns are recognized without resolving ambiguous aliases", () => {
  for (const referenceHeader of ["Transaction ID", "Txn ID", "ID"]) {
    const headers = ["Date", "Amount", referenceHeader, "Category"];
    const mapping = suggestMapping(headers, "ledger");
    assert.equal(mapping.reference, 2);
    assert.equal(mapping.account, 3);
    assert.deepEqual(mappingProblems(headers, mapping), []);
  }
  assert.equal(suggestMapping(["Date", "Amount", "Reference", "Transaction ID"], "bank").reference, -1);
});

test("large duplicate groups retain every transaction with bounded descriptions for every affected row", () => {
  const count = 1000;
  const text = "Date,Description,Reference,Amount\n" + Array.from({ length: count }, () => "2026-10-02,Same,REF-1,10").join("\n");
  const source = parseCsv(text, "many-duplicates.csv");
  const dataset = buildDataset(source, suggestMapping(source.headers, "bank"), "bank");
  assert.equal(dataset.transactions.length, count);
  assert.equal(source.rows.length, count);
  for (const type of ["duplicate-transaction", "repeated-reference"]) {
    const issues = dataset.issues.filter(({ issueType }) => issueType === type);
    assert.equal(issues.length, count);
    assert.equal(new Set(issues.map(({ row }) => row)).size, count);
    for (const { description } of issues) {
      assert.ok(description.length < 250);
      assert.ok(description.includes("2, 3, 4, 5, 6, ..."));
      assert.ok(description.includes("1000 records total"));
      assert.ok(!description.includes("1001"));
    }
  }
});


test("bank account-like headers stay available for manual description mapping", () => {
  const headers = ["Date", "Account", "Amount"];
  const suggested = suggestMapping(headers, "bank");
  assert.equal(suggested.account, -1);
  const manual = { ...suggested, description: 1 };
  assert.deepEqual(mappingProblems(headers, manual), []);
  const source = parseCsv("Date,Account,Amount\n2026-10-02,Customer payment,100", "bank-account-description.csv");
  const dataset = buildDataset(source, manual, "bank");
  assert.equal(dataset.transactions[0].description, "Customer payment");
  assert.equal(dataset.transactions[0].descriptionKey, "customer payment");
  assert.equal(dataset.transactions[0].account, "");
  assert.equal(suggestMapping(headers, "ledger").account, 1);
});
