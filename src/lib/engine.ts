import type {
  Analysis, Candidate, ConfirmedPair, Dataset, ReviewState, Summary, Transaction,
} from "./types";

export const MAX_CANDIDATES = 100_000;
const WINDOW_DAYS = 3;
const ZERO = BigInt(0);

type RankedCandidate = { candidate: Candidate; strength: number };
type Files = { bankById: Map<string, Transaction>; ledgerById: Map<string, Transaction> };

export function pairKey(bankId: string, ledgerId: string): string {
  return JSON.stringify([bankId, ledgerId]);
}

function validForMatch(transaction: Transaction): boolean {
  return transaction.amount !== null && Boolean(transaction.date)
    && transaction.day !== null && Number.isSafeInteger(transaction.day);
}

function indexFiles(bank: Dataset, ledger: Dataset): Files {
  const index = (dataset: Dataset, side: "bank" | "ledger") => {
    if (dataset.side !== side || dataset.transactions.some((transaction) => transaction.side !== side)) {
      throw new Error(`Use transactions from the ${side} file on the ${side} side.`);
    }
    const transactions = new Map<string, Transaction>();
    for (const transaction of dataset.transactions) {
      if (!transaction.id || transactions.has(transaction.id)) {
        throw new Error(`The ${side} file contains missing or duplicate transaction identifiers.`);
      }
      transactions.set(transaction.id, transaction);
    }
    return transactions;
  };
  return { bankById: index(bank, "bank"), ledgerById: index(ledger, "ledger") };
}

function checkPair(files: Files, bankId: string, ledgerId: string) {
  const bank = files.bankById.get(bankId);
  const ledger = files.ledgerById.get(ledgerId);
  if (!bank || !ledger) throw new Error("Choose one transaction from the bank file and one from the ledger file.");
  if (!validForMatch(bank) || !validForMatch(ledger)) {
    throw new Error("Both transactions need valid dates and amounts before they can be matched.");
  }
  if (bank.amount !== ledger.amount) throw new Error("Matched transactions must have the same signed amount.");
  return { bank, ledger, dateDifference: Math.abs(bank.day! - ledger.day!) };
}

function validatePairs(files: Files, pairs: ConfirmedPair[]) {
  const bankIds = new Set<string>();
  const ledgerIds = new Set<string>();
  for (const pair of pairs) {
    const checked = checkPair(files, pair.bankId, pair.ledgerId);
    if (bankIds.has(pair.bankId) || ledgerIds.has(pair.ledgerId)) {
      throw new Error("Each transaction can belong to only one confirmed match.");
    }
    if (pair.kind !== "manual" && checked.dateDifference > WINDOW_DAYS) {
      throw new Error("An automatic or confirmed suggestion must be within the 3-day date window.");
    }
    bankIds.add(pair.bankId);
    ledgerIds.add(pair.ledgerId);
  }
  return { bankIds, ledgerIds };
}

function referenceCounts(dataset: Dataset) {
  const counts = new Map<string, number>();
  for (const transaction of dataset.transactions) {
    if (transaction.referenceKey) counts.set(transaction.referenceKey, (counts.get(transaction.referenceKey) ?? 0) + 1);
  }
  return counts;
}

function bigrams(text: string) {
  const characters = Array.from(text);
  const counts = new Map<string, number>();
  for (let index = 1; index < characters.length; index += 1) {
    const gram = characters[index - 1] + characters[index];
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return { counts, size: Math.max(0, characters.length - 1) };
}

function candidateList(bank: Dataset, ledger: Dataset, matchedBank: Set<string>, matchedLedger: Set<string>, rejected: Set<string>): RankedCandidate[] {
  const bankReferences = referenceCounts(bank);
  const ledgerReferences = referenceCounts(ledger);
  const ledgerIndex = new Map<bigint, Map<number, Transaction[]>>();
  const gramCache = new Map<string, ReturnType<typeof bigrams>>();
  const features = (text: string) => {
    let grams = gramCache.get(text);
    if (!grams) {
      grams = bigrams(text);
      gramCache.set(text, grams);
    }
    return grams;
  };
  const similarity = (left: string, right: string) => {
    if (!left || !right) return 0;
    if (left === right) return 1;
    const a = features(left);
    const b = features(right);
    if (!a.size || !b.size) return 0;
    let overlap = 0;
    for (const [gram, count] of a.counts) overlap += Math.min(count, b.counts.get(gram) ?? 0);
    return 2 * overlap / (a.size + b.size);
  };

  for (const transaction of ledger.transactions) {
    if (!validForMatch(transaction) || matchedLedger.has(transaction.id)) continue;
    let dates = ledgerIndex.get(transaction.amount!);
    if (!dates) {
      dates = new Map();
      ledgerIndex.set(transaction.amount!, dates);
    }
    const group = dates.get(transaction.day!);
    if (group) group.push(transaction);
    else dates.set(transaction.day!, [transaction]);
  }

  const ranked: RankedCandidate[] = [];
  for (const bankTransaction of bank.transactions) {
    if (!validForMatch(bankTransaction) || matchedBank.has(bankTransaction.id)) continue;
    const dates = ledgerIndex.get(bankTransaction.amount!);
    if (!dates) continue;
    for (let delta = -WINDOW_DAYS; delta <= WINDOW_DAYS; delta += 1) {
      const ledgerTransactions = dates.get(bankTransaction.day! + delta) ?? [];
      for (const ledgerTransaction of ledgerTransactions) {
        if (rejected.has(pairKey(bankTransaction.id, ledgerTransaction.id))) continue;
        if (ranked.length >= MAX_CANDIDATES) {
          throw new Error("Too many possible matches (over 100,000 candidate pairs). Split the files into smaller date ranges or account batches, then try again.");
        }
        const exactReference = Boolean(bankTransaction.referenceKey)
          && bankTransaction.referenceKey === ledgerTransaction.referenceKey;
        const uniqueReference = exactReference && bankReferences.get(bankTransaction.referenceKey) === 1
          && ledgerReferences.get(ledgerTransaction.referenceKey) === 1;
        const conflictingReferences = Boolean(bankTransaction.referenceKey && ledgerTransaction.referenceKey)
          && bankTransaction.referenceKey !== ledgerTransaction.referenceKey;
        const descriptionSimilarity = similarity(bankTransaction.descriptionKey, ledgerTransaction.descriptionKey);
        const strongDescription = descriptionSimilarity >= 0.8 && !conflictingReferences;
        const strength = uniqueReference ? 2 : strongDescription ? 1 : 0;
        const dateDifference = Math.abs(delta);
        const details = ["Exact signed amount"];
        if (uniqueReference) details.push("unique matching reference in both files");
        else if (exactReference) details.push("matching reference is repeated and is not reliable by itself");
        else if (conflictingReferences) details.push("references differ");
        if (descriptionSimilarity > 0) details.push(`description similarity ${Math.round(descriptionSimilarity * 100)}%`);
        details.push(`${dateDifference}-day date difference`);
        ranked.push({
          strength,
          candidate: {
            bankId: bankTransaction.id,
            ledgerId: ledgerTransaction.id,
            score: (exactReference ? uniqueReference ? 30_000 : 20_000 : 0)
              + Math.round(descriptionSimilarity * 10_000) + (WINDOW_DAYS - dateDifference),
            confidence: strength > 0 ? "High" : "Possible",
            dateDifference,
            reason: details.join("; ") + ".",
          },
        });
      }
    }
  }
  ranked.sort((left, right) => right.candidate.score - left.candidate.score
    || left.candidate.dateDifference - right.candidate.dateDifference
    || compareIds(left.candidate.bankId, right.candidate.bankId)
    || compareIds(left.candidate.ledgerId, right.candidate.ledgerId));
  return ranked;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Auto decisions are made once, from the full original candidate graph. */
export function initialReview(bank: Dataset, ledger: Dataset): ReviewState {
  indexFiles(bank, ledger);
  const ranked = candidateList(bank, ledger, new Set(), new Set(), new Set());
  type Choice = { strength: number; count: number; candidate: Candidate };
  const bankChoices = new Map<string, Choice>();
  const ledgerChoices = new Map<string, Choice>();
  const consider = (choices: Map<string, Choice>, id: string, entry: RankedCandidate) => {
    if (!entry.strength) return;
    const current = choices.get(id);
    if (!current || entry.strength > current.strength) {
      choices.set(id, { strength: entry.strength, count: 1, candidate: entry.candidate });
    } else if (entry.strength === current.strength) current.count += 1;
  };
  for (const entry of ranked) {
    consider(bankChoices, entry.candidate.bankId, entry);
    consider(ledgerChoices, entry.candidate.ledgerId, entry);
  }
  const pairs: ConfirmedPair[] = [];
  for (const { candidate } of ranked) {
    const bankChoice = bankChoices.get(candidate.bankId);
    const ledgerChoice = ledgerChoices.get(candidate.ledgerId);
    if (bankChoice?.count === 1 && ledgerChoice?.count === 1
      && bankChoice.candidate === candidate && ledgerChoice.candidate === candidate) {
      pairs.push({ ...candidate, kind: "auto" });
    }
  }
  return { pairs, rejected: [] };
}

/** Suggestions are recalculated; no review action silently creates auto matches. */
export function analyze(bank: Dataset, ledger: Dataset, state: ReviewState): Analysis {
  const files = indexFiles(bank, ledger);
  const matched = validatePairs(files, state.pairs);
  const ranked = candidateList(bank, ledger, matched.bankIds, matched.ledgerIds, new Set(state.rejected));
  return {
    pairs: state.pairs.map((pair) => ({ ...pair })),
    suggestions: ranked.map(({ candidate }) => candidate),
    unmatchedBank: bank.transactions.filter((transaction) => !matched.bankIds.has(transaction.id)),
    unmatchedLedger: ledger.transactions.filter((transaction) => !matched.ledgerIds.has(transaction.id)),
    issues: [...bank.issues, ...ledger.issues].map((issue) => ({ ...issue })),
  };
}

export function summarize(bank: Dataset, ledger: Dataset, analysis: Analysis): Summary {
  const files = indexFiles(bank, ledger);
  const matched = validatePairs(files, analysis.pairs);
  const sum = (transactions: Transaction[]) => transactions.reduce((total, transaction) => total + (transaction.amount ?? ZERO), ZERO);
  const bankTotal = sum(bank.transactions);
  const ledgerTotal = sum(ledger.transactions);
  const unmatchedBank = bank.transactions.filter((transaction) => !matched.bankIds.has(transaction.id));
  const unmatchedLedger = ledger.transactions.filter((transaction) => !matched.ledgerIds.has(transaction.id));
  const matchedAmount = analysis.pairs.reduce((total, pair) => total + files.bankById.get(pair.bankId)!.amount!, ZERO);
  return {
    bankCount: bank.transactions.length,
    ledgerCount: ledger.transactions.length,
    bankTotal,
    ledgerTotal,
    matchedCount: analysis.pairs.length,
    suggestedCount: analysis.suggestions.length,
    unmatchedBankCount: unmatchedBank.length,
    unmatchedLedgerCount: unmatchedLedger.length,
    matchedAmount,
    unreconciledBank: sum(unmatchedBank),
    unreconciledLedger: sum(unmatchedLedger),
    difference: bankTotal - ledgerTotal,
    bankAmountsComplete: bank.transactions.every((transaction) => transaction.amount !== null),
    ledgerAmountsComplete: ledger.transactions.every((transaction) => transaction.amount !== null),
  };
}

export function confirmSuggestion(bank: Dataset, ledger: Dataset, state: ReviewState, bankId: string, ledgerId: string): ReviewState {
  const candidate = analyze(bank, ledger, state).suggestions.find((suggestion) => suggestion.bankId === bankId && suggestion.ledgerId === ledgerId);
  if (!candidate) throw new Error("This pair is not a current suggestion. Choose an available suggested pair.");
  return {
    pairs: [...state.pairs.map((pair) => ({ ...pair })), { ...candidate, kind: "confirmed" }],
    rejected: [...state.rejected],
  };
}

export function rejectSuggestion(state: ReviewState, bankId: string, ledgerId: string): ReviewState {
  if (state.pairs.some((pair) => pair.bankId === bankId && pair.ledgerId === ledgerId)) {
    throw new Error("This pair is already matched. Undo the match before rejecting it.");
  }
  return {
    pairs: state.pairs.map((pair) => ({ ...pair })),
    rejected: [...new Set([...state.rejected, pairKey(bankId, ledgerId)])],
  };
}

export function manualMatch(bank: Dataset, ledger: Dataset, state: ReviewState, bankId: string, ledgerId: string): ReviewState {
  const files = indexFiles(bank, ledger);
  const matched = validatePairs(files, state.pairs);
  const checked = checkPair(files, bankId, ledgerId);
  if (matched.bankIds.has(bankId) || matched.ledgerIds.has(ledgerId)) {
    throw new Error("One of these transactions is already matched. Undo its match first.");
  }
  const pair: ConfirmedPair = {
    bankId, ledgerId, kind: "manual", confidence: "Possible", score: 0,
    dateDifference: checked.dateDifference,
    reason: `Manually matched by review: exact signed amount; ${checked.dateDifference}-day date difference${checked.dateDifference > WINDOW_DAYS ? "; outside the 3-day suggestion window" : ""}.`,
  };
  return {
    pairs: [...state.pairs.map((existing) => ({ ...existing })), pair],
    rejected: state.rejected.filter((key) => key !== pairKey(bankId, ledgerId)),
  };
}

export function undoMatch(state: ReviewState, bankId: string, ledgerId: string): ReviewState {
  if (!state.pairs.some((pair) => pair.bankId === bankId && pair.ledgerId === ledgerId)) {
    throw new Error("This match no longer exists.");
  }
  return {
    pairs: state.pairs.filter((pair) => pair.bankId !== bankId || pair.ledgerId !== ledgerId).map((pair) => ({ ...pair })),
    rejected: state.rejected.filter((key) => key !== pairKey(bankId, ledgerId)),
  };
}
