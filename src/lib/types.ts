export type Side = "bank" | "ledger";
export type DateFormat = "iso" | "dmy" | "mdy";
export type RawRow = { row: number; cells: string[] };
export type ParsedCsv = { filename: string; headers: string[]; rows: RawRow[] };
export type Mapping = {
  date: number; description: number; reference: number; account: number;
  dateFormat: DateFormat; sign: 1 | -1;
} & ({ format: "signed"; amount: number } | { format: "debit-credit"; debit: number; credit: number });
export type DataIssue = { side: Side; row: number; severity: "Error" | "Warning"; issueType: string; description: string };
export type Transaction = {
  id: string; side: Side; row: number; cells: string[];
  rawDate: string; rawAmount: string; description: string; reference: string; account: string;
  date: string | null; day: number | null; amount: bigint | null;
  descriptionKey: string; referenceKey: string;
};
export type Dataset = { side: Side; source: ParsedCsv; mapping: Mapping; transactions: Transaction[]; issues: DataIssue[] };
export type Candidate = { bankId: string; ledgerId: string; score: number; confidence: "High" | "Possible"; dateDifference: number; reason: string };
export type ConfirmedPair = Candidate & { kind: "auto" | "confirmed" | "manual" };
export type ReviewState = { pairs: ConfirmedPair[]; rejected: string[] };
export type Analysis = { pairs: ConfirmedPair[]; suggestions: Candidate[]; unmatchedBank: Transaction[]; unmatchedLedger: Transaction[]; issues: DataIssue[] };
export type Summary = {
  bankCount: number; ledgerCount: number; bankTotal: bigint; ledgerTotal: bigint;
  matchedCount: number; suggestedCount: number; unmatchedBankCount: number; unmatchedLedgerCount: number;
  matchedAmount: bigint; unreconciledBank: bigint; unreconciledLedger: bigint; difference: bigint;
  bankAmountsComplete: boolean; ledgerAmountsComplete: boolean;
};
