import { encodeCsv } from "./csv";
import { formatAmount } from "./money";
import type { Analysis, Dataset, Summary, Transaction } from "./types";

function literal(value: string): string {
  return /^[\t\r\n ]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? "'" + value : value;
}
function transactionCells(transaction?: Transaction): string[] {
  if (!transaction) return ["", "", "", "", ""];
  return [String(transaction.row), literal(transaction.date ?? transaction.rawDate), transaction.amount === null ? literal(transaction.rawAmount) : formatAmount(transaction.amount), literal(transaction.description), literal(transaction.reference)];
}

/** Export the full analysis, independent of display filters. Proposals remain labelled. */
export function reconciliationReportCsv(bank: Dataset, ledger: Dataset, analysis: Analysis): string {
  const banks = new Map(bank.transactions.map(row => [row.id, row]));
  const ledgers = new Map(ledger.transactions.map(row => [row.id, row]));
  const rows: string[][] = [["status", "bankRow", "bankDate", "bankAmount", "bankDescription", "bankReference", "ledgerRow", "ledgerDate", "ledgerAmount", "ledgerDescription", "ledgerReference", "matchReason"]];
  for (const pair of analysis.pairs) rows.push([pair.kind === "auto" ? "AUTO MATCHED" : pair.kind === "manual" ? "MANUAL MATCHED" : "CONFIRMED", ...transactionCells(banks.get(pair.bankId)), ...transactionCells(ledgers.get(pair.ledgerId)), literal(pair.reason)]);
  for (const pair of analysis.suggestions) rows.push(["SUGGESTED", ...transactionCells(banks.get(pair.bankId)), ...transactionCells(ledgers.get(pair.ledgerId)), literal(pair.reason)]);
  const bankProposals = new Set(analysis.suggestions.map(pair => pair.bankId));
  const ledgerProposals = new Set(analysis.suggestions.map(pair => pair.ledgerId));
  for (const row of analysis.unmatchedBank) if (!bankProposals.has(row.id)) rows.push(["BANK UNMATCHED", ...transactionCells(row), ...transactionCells(), "No active candidate; review the source and data issues."]);
  for (const row of analysis.unmatchedLedger) if (!ledgerProposals.has(row.id)) rows.push(["LEDGER UNMATCHED", ...transactionCells(), ...transactionCells(row), "No active candidate; review the source and data issues."]);
  return encodeCsv(rows);
}

/** All unpaired rows, including those awaiting suggestion review. */
export function unmatchedReportCsv(transactions: Transaction[]): string {
  return encodeCsv([
    ["row", "date", "amount", "description", "reference", "account"],
    ...transactions.map(row => [...transactionCells(row), literal(row.account)]),
  ]);
}

export function summaryReportCsv(summary: Summary): string {
  return encodeCsv([
    ["bankCount", "bankTotal", "ledgerCount", "ledgerTotal", "matchedCount", "suggestedCount", "unmatchedBankCount", "unmatchedLedgerCount", "matchedAmount", "unreconciledBank", "unreconciledLedger", "difference", "bankAmountsComplete", "ledgerAmountsComplete"],
    [String(summary.bankCount), formatAmount(summary.bankTotal), String(summary.ledgerCount), formatAmount(summary.ledgerTotal), String(summary.matchedCount), String(summary.suggestedCount), String(summary.unmatchedBankCount), String(summary.unmatchedLedgerCount), formatAmount(summary.matchedAmount), formatAmount(summary.unreconciledBank), formatAmount(summary.unreconciledLedger), formatAmount(summary.difference), summary.bankAmountsComplete ? "YES" : "NO", summary.ledgerAmountsComplete ? "YES" : "NO"],
  ]);
}

export function downloadCsv(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
