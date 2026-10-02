import { mappingProblems } from "./mapping";
import { parseAmount } from "./money";
import type { DataIssue, Dataset, DateFormat, Mapping, ParsedCsv, Side, Transaction } from "./types";

const ZERO = BigInt(0);
const DAY_MS = 86_400_000;

export function normalizeDescription(input: string): string {
  return input.normalize("NFKC").toLowerCase().replace(/[\p{P}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function normalizeReference(input: string): string {
  return input.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Accept only the selected date convention, never guess an ambiguous date. */
export function normalizeDate(input: string, dateFormat: DateFormat): { date: string; day: number } | null {
  const value = input.trim()
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
  let year: number; let month: number; let day: number;
  if (dateFormat === "iso") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  } else if (dateFormat === "dmy" || dateFormat === "mdy") {
    const match = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$/.exec(value);
    if (!match) return null;
    year = Number(match[4]);
    month = Number(dateFormat === "dmy" ? match[3] : match[1]);
    day = Number(dateFormat === "dmy" ? match[1] : match[3]);
  } else return null;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // setUTCFullYear avoids Date.UTC's special conversion of years 00 through 99.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return { date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, day: calendar.getTime() / DAY_MS };
}

function addGroup(groups: Map<string, Transaction[]>, key: string, transaction: Transaction) {
  if (!key) return;
  const values = groups.get(key);
  if (values) values.push(transaction);
  else groups.set(key, [transaction]);
}

/** Keep every nonblank source record, including records ineligible for matching. */
export function buildDataset(source: ParsedCsv, mapping: Mapping, side: Side): Dataset {
  const problems = mappingProblems(source.headers, mapping);
  if (problems.length) throw new Error(problems.join(" "));
  const transactions: Transaction[] = [];
  const issues: DataIssue[] = [];
  const fingerprints = new Map<string, Transaction[]>();
  const references = new Map<string, Transaction[]>();
  const issue = (row: number, severity: DataIssue["severity"], issueType: string, description: string) => {
    issues.push({ side, row, severity, issueType, description });
  };

  for (const record of source.rows) {
    if (record.cells.every((cell) => !cell.trim())) {
      issue(record.row, "Error", "empty-row", "This CSV record is empty or contains only whitespace.");
      continue;
    }
    const value = (index: number) => index < 0 ? "" : record.cells[index] ?? "";
    const rawDate = value(mapping.date);
    const description = value(mapping.description);
    const reference = value(mapping.reference);
    const account = value(mapping.account);
    const date = normalizeDate(rawDate, mapping.dateFormat);
    if (!date) issue(record.row, "Error", rawDate.trim() ? "invalid-date" : "missing-date", `The date is missing or is not a valid calendar date in the selected ${mapping.dateFormat.toUpperCase()} format.`);
    if (record.cells.length !== source.headers.length) issue(record.row, "Error", "row-width", `This record has ${record.cells.length} columns; the header has ${source.headers.length}.`);
    if (record.cells.some((cell) => cell !== cell.trim())) issue(record.row, "Warning", "whitespace", "Some source cells contain surrounding whitespace. Original text was preserved.");

    let rawAmount: string;
    let amount: bigint | null = null;
    if (mapping.format === "signed") {
      rawAmount = value(mapping.amount);
      const parsed = parseAmount(rawAmount);
      if (parsed.kind === "empty") issue(record.row, "Error", "missing-amount", "The signed amount is missing.");
      else if (parsed.kind === "invalid") issue(record.row, "Error", "invalid-amount", parsed.reason);
      else {
        amount = parsed.cents * BigInt(mapping.sign);
        if (parsed.rounded) issue(record.row, "Warning", "rounded-amount", "The supplied amount has more than two fractional digits and was rounded to cents, half away from zero. Source text was preserved.");
      }
    } else {
      const debitInput = value(mapping.debit);
      const creditInput = value(mapping.credit);
      rawAmount = `Debit: ${debitInput}; Credit: ${creditInput}`;
      const debitPopulated = Boolean(debitInput.trim());
      const creditPopulated = Boolean(creditInput.trim());
      const debit = parseAmount(debitInput);
      const credit = parseAmount(creditInput);
      if (debitPopulated && creditPopulated) issue(record.row, "Error", "both-debit-and-credit", "Both debit and credit are populated, including explicit zeros. The amount is ambiguous and excluded from matching.");
      else if (!debitPopulated && !creditPopulated) issue(record.row, "Error", "missing-amount", "Neither debit nor credit has an amount.");
      const negativeInput = (input: string) => /^(?:-|\()/.test(input.trim()) && /[1-9\u0661-\u0669\u06f1-\u06f9]/.test(input);
      const debitNegative = debit.kind === "valid" && (debit.cents < ZERO || negativeInput(debitInput));
      const creditNegative = credit.kind === "valid" && (credit.cents < ZERO || negativeInput(creditInput));
      for (const [label, parsed, negative] of [["Debit", debit, debitNegative], ["Credit", credit, creditNegative]] as const) {
        if (parsed.kind === "invalid") issue(record.row, "Error", "invalid-amount", `${label}: ${parsed.reason}`);
        if (negative) issue(record.row, "Error", "negative-debit-credit", `${label} is negative. Use a nonnegative amount on the appropriate side; this row is excluded from matching.`);
        if (parsed.kind === "valid" && parsed.rounded) issue(record.row, "Warning", "rounded-amount", `${label} has more than two fractional digits and was rounded to cents, half away from zero. Source text was preserved.`);
      }
      if (debitPopulated !== creditPopulated) {
        const active = debitPopulated ? debit : credit;
        if (active.kind === "valid" && !(debitPopulated ? debitNegative : creditNegative)) amount = (debitPopulated ? active.cents : -active.cents) * BigInt(mapping.sign);
      }
    }

    const transaction: Transaction = {
      id: `${side}:${record.row}`, side, row: record.row, cells: [...record.cells],
      rawDate, rawAmount, description, reference, account,
      date: date?.date ?? null, day: date?.day ?? null, amount,
      descriptionKey: normalizeDescription(description), referenceKey: normalizeReference(reference),
    };
    transactions.push(transaction);
    const fingerprint = transaction.date !== null && transaction.amount !== null
      ? JSON.stringify(["normalized", transaction.date, transaction.amount.toString(), transaction.descriptionKey, transaction.referenceKey, normalizeReference(account)])
      : JSON.stringify(["invalid-raw", record.cells]);
    addGroup(fingerprints, fingerprint, transaction);
    addGroup(references, transaction.referenceKey, transaction);
  }

  for (const group of fingerprints.values()) {
    if (group.length < 2) continue;
    const records = group.slice(0, 5).map(({ row }) => row).join(", ") + (group.length > 5 ? ", ..." : "") + ` (${group.length} records total)`;
    for (const transaction of group) issue(transaction.row, "Warning", "duplicate-transaction", `Possible duplicate transactions in CSV records ${records}. Every source record was retained.`);
  }
  for (const group of references.values()) {
    if (group.length < 2) continue;
    const records = group.slice(0, 5).map(({ row }) => row).join(", ") + (group.length > 5 ? ", ..." : "") + ` (${group.length} records total)`;
    for (const transaction of group) issue(transaction.row, "Warning", "repeated-reference", `This normalized reference appears in CSV records ${records}. Verify whether the repetition is expected.`);
  }
  return { side, source, mapping: { ...mapping }, transactions, issues };
}
