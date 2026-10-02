import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  analyze, confirmSuggestion, initialReview, manualMatch, MAX_CANDIDATES,
  pairKey, rejectSuggestion, summarize, undoMatch,
} from "../src/lib/engine";
import type { Dataset, ReviewState, Side, Transaction } from "../src/lib/types";

function transaction(side: Side, id: string, amount: string | null = "10000", day: number | null = 100, extra: Partial<Transaction> = {}): Transaction {
  const date = day === null ? null : new Date(day * 86_400_000).toISOString().slice(0, 10);
  return {
    id: `${side}:${id}`, side, row: Number(id) + 2 || 2, cells: [],
    rawDate: date ?? "invalid", rawAmount: amount ?? "invalid",
    description: extra.descriptionKey ?? "", reference: extra.referenceKey ?? "", account: "",
    date, day, amount: amount === null ? null : BigInt(amount),
    descriptionKey: "", referenceKey: "", ...extra,
  };
}

function dataset(side: Side, transactions: Transaction[]): Dataset {
  return {
    side,
    source: { filename: `${side}.csv`, headers: ["Date", "Description", "Amount", "Reference"], rows: transactions.map((item) => ({ row: item.row, cells: [...item.cells] })) },
    mapping: { format: "signed", date: 0, description: 1, amount: 2, reference: 3, account: -1, sign: 1, dateFormat: "iso" },
    transactions, issues: [],
  };
}

function emptyState(): ReviewState { return { pairs: [], rejected: [] }; }
function files(bank: Transaction[], ledger: Transaction[]) {
  return { bank: dataset("bank", bank), ledger: dataset("ledger", ledger) };
}
function onePair(extraBank: Partial<Transaction> = {}, extraLedger: Partial<Transaction> = {}, ledgerDay = 100) {
  return files([transaction("bank", "1", "10000", 100, extraBank)], [transaction("ledger", "1", "10000", ledgerDay, extraLedger)]);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function ambiguous() {
  return files(
    [transaction("bank", "1", "10000", 100, { descriptionKey: "office rental" }), transaction("bank", "2", "10000", 100, { descriptionKey: "office rental" })],
    [transaction("ledger", "1", "10000", 100, { descriptionKey: "office rental" }), transaction("ledger", "2", "10000", 100, { descriptionKey: "office rental" })],
  );
}

describe("candidate evidence and automatic matching", () => {
  test("auto matches a mutual unique reference with an exact signed amount and close date", () => {
    const { bank, ledger } = onePair({ referenceKey: "invoice42", descriptionKey: "bank wording" }, { referenceKey: "invoice42", descriptionKey: "ledger wording" }, 103);
    const state = initialReview(bank, ledger);
    assert.equal(state.pairs.length, 1);
    assert.equal(state.pairs[0].kind, "auto");
    assert.equal(state.pairs[0].confidence, "High");
    assert.equal(state.pairs[0].dateDifference, 3);
    assert.match(state.pairs[0].reason, /unique matching reference/);
    assert.deepEqual(state.rejected, []);
    assert.equal(analyze(bank, ledger, state).suggestions.length, 0);
  });

  test("a unique reference outranks a description alternative", () => {
    const { bank, ledger } = files(
      [transaction("bank", "1", "10000", 100, { referenceKey: "ref1", descriptionKey: "office rental" })],
      [transaction("ledger", "1", "10000", 103, { referenceKey: "ref1", descriptionKey: "unrelated" }), transaction("ledger", "2", "10000", 100, { descriptionKey: "office rental" })],
    );
    const state = initialReview(bank, ledger);
    assert.equal(state.pairs.length, 1);
    assert.equal(state.pairs[0].ledgerId, "ledger:1");
    assert.equal(analyze(bank, ledger, state).unmatchedLedger[0].id, "ledger:2");
  });

  test("unique identical descriptions can auto match without references", () => {
    const { bank, ledger } = onePair({ descriptionKey: "office rental" }, { descriptionKey: "office rental" });
    assert.equal(initialReview(bank, ledger).pairs[0].kind, "auto");
  });

  test("unique fuzzy descriptions above the similarity threshold can auto match", () => {
    const { bank, ledger } = onePair({ descriptionKey: "office rental" }, { descriptionKey: "office rentals" });
    const state = initialReview(bank, ledger);
    assert.equal(state.pairs.length, 1);
    assert.match(state.pairs[0].reason, /description similarity 96%/);
  });

  test("conflicting nonempty references prevent description-based auto matching", () => {
    const { bank, ledger } = onePair({ descriptionKey: "office rental", referenceKey: "ref1" }, { descriptionKey: "office rental", referenceKey: "ref2" });
    assert.equal(initialReview(bank, ledger).pairs.length, 0);
    const candidate = analyze(bank, ledger, emptyState()).suggestions[0];
    assert.equal(candidate.confidence, "Possible");
    assert.match(candidate.reason, /references differ/);
  });

  test("amount and date alone remain a suggestion even when the pair is unique", () => {
    const { bank, ledger } = onePair();
    assert.equal(initialReview(bank, ledger).pairs.length, 0);
    const suggestions = analyze(bank, ledger, emptyState()).suggestions;
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].confidence, "Possible");
  });

  test("short unrelated descriptions are not strong evidence", () => {
    const { bank, ledger } = onePair({ descriptionKey: "a" }, { descriptionKey: "b" });
    assert.equal(initialReview(bank, ledger).pairs.length, 0);
    assert.equal(analyze(bank, ledger, emptyState()).suggestions[0].confidence, "Possible");
  });

  test("equal strong descriptions at different dates stay ambiguous", () => {
    const { bank, ledger } = files(
      [transaction("bank", "1", "10000", 100, { descriptionKey: "office rental" })],
      [transaction("ledger", "1", "10000", 100, { descriptionKey: "office rental" }), transaction("ledger", "2", "10000", 102, { descriptionKey: "office rental" })],
    );
    assert.equal(initialReview(bank, ledger).pairs.length, 0, "a closer date does not resolve equally strong identities");
    assert.equal(analyze(bank, ledger, emptyState()).suggestions[0].ledgerId, "ledger:1");
  });

  test("cross-contention requires mutual uniqueness rather than bank-side uniqueness alone", () => {
    const { bank, ledger } = files(
      [transaction("bank", "1", "10000", 100, { descriptionKey: "office rental" }), transaction("bank", "2", "10000", 101, { descriptionKey: "office rental" })],
      [transaction("ledger", "1", "10000", 100, { descriptionKey: "office rental" })],
    );
    assert.equal(initialReview(bank, ledger).pairs.length, 0);
    assert.equal(analyze(bank, ledger, emptyState()).suggestions.length, 2);
  });

  test("a repeated same-amount graph never produces silent automatic pairs", () => {
    const { bank, ledger } = ambiguous();
    assert.equal(initialReview(bank, ledger).pairs.length, 0);
    assert.equal(analyze(bank, ledger, emptyState()).suggestions.length, 4);
  });

  test("repeated references are not reliable strong evidence", () => {
    const { bank, ledger } = files(
      [transaction("bank", "1", "10000", 100, { referenceKey: "batch" }), transaction("bank", "2", "10000", 101, { referenceKey: "batch" })],
      [transaction("ledger", "1", "10000", 100, { referenceKey: "batch" })],
    );
    assert.equal(initialReview(bank, ledger).pairs.length, 0);
    const suggestions = analyze(bank, ledger, emptyState()).suggestions;
    assert.equal(suggestions.length, 2);
    assert.ok(suggestions.every((candidate) => candidate.confidence === "Possible"));
    assert.match(suggestions[0].reason, /reference is repeated/);
  });

  test("reference repetition counts the full file even invalid or differently priced rows", () => {
    for (const duplicateAmount of [null, "99999"]) {
      const { bank, ledger } = files(
        [transaction("bank", "1", "10000", 100, { referenceKey: "batch" }), transaction("bank", "2", duplicateAmount, 130, { referenceKey: "batch" })],
        [transaction("ledger", "1", "10000", 100, { referenceKey: "batch" })],
      );
      assert.equal(initialReview(bank, ledger).pairs.length, 0);
      assert.equal(analyze(bank, ledger, emptyState()).suggestions[0].confidence, "Possible");
    }
  });

  test("unique descriptions can identify pairs independently of repeated references", () => {
    const { bank, ledger } = files(
      [transaction("bank", "1", "10000", 100, { referenceKey: "batch", descriptionKey: "rental payment" }), transaction("bank", "2", "10000", 100, { referenceKey: "batch", descriptionKey: "electricity charge" })],
      [transaction("ledger", "1", "10000", 100, { referenceKey: "batch", descriptionKey: "rental payment" }), transaction("ledger", "2", "10000", 100, { referenceKey: "batch", descriptionKey: "electricity charge" })],
    );
    assert.equal(initialReview(bank, ledger).pairs.length, 2);
  });

  test("requires exact signed cents rather than an amount tolerance or absolute equality", () => {
    for (const amount of ["10001", "9999", "-10000"]) {
      const { bank, ledger } = files([transaction("bank", "1")], [transaction("ledger", "1", amount)]);
      assert.equal(initialReview(bank, ledger).pairs.length, 0);
      assert.equal(analyze(bank, ledger, emptyState()).suggestions.length, 0);
    }
  });

  test("accepts both inclusive three-day boundaries and excludes dates four days apart", () => {
    for (const [day, expected] of [[97, 1], [103, 1], [96, 0], [104, 0]]) {
      const { bank, ledger } = onePair({}, {}, day);
      assert.equal(analyze(bank, ledger, emptyState()).suggestions.length, expected, String(day));
    }
  });

  test("invalid date or amount rows cannot be candidates but stay in unmatched arrays", () => {
    const { bank, ledger } = files(
      [transaction("bank", "1", null), transaction("bank", "2", "10000", null), transaction("bank", "3", "10000", 100, { date: null })],
      [transaction("ledger", "1", "10000")],
    );
    const analysis = analyze(bank, ledger, initialReview(bank, ledger));
    assert.equal(analysis.suggestions.length, 0);
    assert.equal(analysis.unmatchedBank.length, 3);
    assert.equal(analysis.unmatchedLedger.length, 1);
  });

  test("ranks references, then description similarity, then date deterministically", () => {
    const { bank, ledger } = files(
      [transaction("bank", "1", "10000", 100, { referenceKey: "ref1", descriptionKey: "office rental" })],
      [transaction("ledger", "a", "10000", 103, { referenceKey: "ref1" }), transaction("ledger", "b", "10000", 100, { descriptionKey: "office rental" }), transaction("ledger", "c", "10000", 102, { descriptionKey: "office rental" }), transaction("ledger", "d", "10000", 100, { descriptionKey: "office rentals" })],
    );
    const suggestions = analyze(bank, ledger, emptyState()).suggestions;
    assert.deepEqual(suggestions.map((candidate) => candidate.ledgerId), ["ledger:a", "ledger:b", "ledger:c", "ledger:d"]);
    assert.deepEqual(analyze(bank, dataset("ledger", [...ledger.transactions].reverse()), emptyState()).suggestions, suggestions);
  });

  test("zero amounts are valid candidates and remain reviewable without strong evidence", () => {
    const { bank, ledger } = files([transaction("bank", "1", "0")], [transaction("ledger", "1", "0")]);
    assert.equal(initialReview(bank, ledger).pairs.length, 0);
    assert.equal(analyze(bank, ledger, emptyState()).suggestions.length, 1);
  });
});

describe("review actions and one-to-one matching", () => {
  test("confirmation moves only a current suggestion to a confirmed pair", () => {
    const { bank, ledger } = onePair();
    const before = emptyState();
    const state = confirmSuggestion(bank, ledger, before, "bank:1", "ledger:1");
    assert.equal(state.pairs[0].kind, "confirmed");
    const analysis = analyze(bank, ledger, state);
    assert.equal(analysis.pairs.length, 1);
    assert.equal(analysis.suggestions.length, 0);
    assert.equal(analysis.unmatchedBank.length, 0);
    assert.equal(analysis.unmatchedLedger.length, 0);
    assert.deepEqual(before, emptyState());
  });

  test("confirmation rejects nonexistent, rejected, or already matched suggestions", () => {
    const { bank, ledger } = onePair();
    const confirmed = confirmSuggestion(bank, ledger, emptyState(), "bank:1", "ledger:1");
    assert.throws(() => confirmSuggestion(bank, ledger, confirmed, "bank:1", "ledger:1"), /not a current suggestion/);
    assert.throws(() => confirmSuggestion(bank, ledger, emptyState(), "bank:missing", "ledger:1"), /not a current suggestion/);
    const rejected = rejectSuggestion(emptyState(), "bank:1", "ledger:1");
    assert.throws(() => confirmSuggestion(bank, ledger, rejected, "bank:1", "ledger:1"), /not a current suggestion/);
  });

  test("rejecting one edge leaves all unpaired transactions and other candidates available", () => {
    const { bank, ledger } = ambiguous();
    const rejected = rejectSuggestion(emptyState(), "bank:1", "ledger:1");
    const twice = rejectSuggestion(rejected, "bank:1", "ledger:1");
    assert.equal(twice.rejected.length, 1);
    const analysis = analyze(bank, ledger, twice);
    assert.equal(analysis.suggestions.length, 3);
    assert.equal(analysis.unmatchedBank.length, 2);
    assert.equal(analysis.unmatchedLedger.length, 2);
    assert.equal(analysis.pairs.length, 0);
  });

  test("confirming one ambiguous pair does not automatically promote the residual pair", () => {
    const { bank, ledger } = ambiguous();
    const state = confirmSuggestion(bank, ledger, initialReview(bank, ledger), "bank:1", "ledger:1");
    const analysis = analyze(bank, ledger, state);
    assert.equal(analysis.pairs.length, 1);
    assert.equal(analysis.suggestions.length, 1);
    assert.equal(analysis.suggestions[0].bankId, "bank:2");
    assert.equal(analysis.unmatchedBank.length, 1);
  });

  test("rejection does not turn an ambiguous alternative into an automatic match", () => {
    const { bank, ledger } = files(
      [transaction("bank", "1", "10000", 100, { descriptionKey: "rent" })],
      [transaction("ledger", "1", "10000", 100, { descriptionKey: "rent" }), transaction("ledger", "2", "10000", 100, { descriptionKey: "rent" })],
    );
    const state = rejectSuggestion(initialReview(bank, ledger), "bank:1", "ledger:1");
    const analysis = analyze(bank, ledger, state);
    assert.equal(analysis.pairs.length, 0);
    assert.equal(analysis.suggestions.length, 1);
  });

  test("manual matching explicitly permits a date difference outside the suggestion window", () => {
    const { bank, ledger } = onePair({}, {}, 120);
    assert.equal(analyze(bank, ledger, emptyState()).suggestions.length, 0);
    const state = manualMatch(bank, ledger, emptyState(), "bank:1", "ledger:1");
    assert.equal(state.pairs[0].kind, "manual");
    assert.equal(state.pairs[0].dateDifference, 20);
    assert.match(state.pairs[0].reason, /outside the 3-day suggestion window/);
    assert.equal(analyze(bank, ledger, state).unmatchedBank.length, 0);
  });

  test("manual matching enforces equal signed amounts, valid dates, and one transaction from each file", () => {
    const { bank, ledger } = files([transaction("bank", "1", "10000")], [transaction("ledger", "1", "10001"), transaction("ledger", "2", "10000", null), transaction("ledger", "3", null)]);
    assert.throws(() => manualMatch(bank, ledger, emptyState(), "bank:1", "ledger:1"), /same signed amount/);
    assert.throws(() => manualMatch(bank, ledger, emptyState(), "bank:1", "ledger:2"), /valid dates and amounts/);
    assert.throws(() => manualMatch(bank, ledger, emptyState(), "bank:1", "ledger:3"), /valid dates and amounts/);
    assert.throws(() => manualMatch(bank, ledger, emptyState(), "bank:1", "bank:1"), /bank file.*ledger file/);
    assert.throws(() => manualMatch(ledger, bank, emptyState(), "ledger:1", "bank:1"), /bank file on the bank side/);
  });

  test("neither side of an existing match can be reused", () => {
    const { bank, ledger } = ambiguous();
    const state = manualMatch(bank, ledger, emptyState(), "bank:1", "ledger:1");
    assert.throws(() => manualMatch(bank, ledger, state, "bank:1", "ledger:2"), /already matched/);
    assert.throws(() => manualMatch(bank, ledger, state, "bank:2", "ledger:1"), /already matched/);
    assert.throws(() => confirmSuggestion(bank, ledger, state, "bank:1", "ledger:2"), /not a current suggestion/);
  });

  test("undoing an automatic pair returns it to suggestions without creating another auto pair", () => {
    const { bank, ledger } = onePair({ referenceKey: "ref1" }, { referenceKey: "ref1" });
    const initial = initialReview(bank, ledger);
    const state = undoMatch(initial, "bank:1", "ledger:1");
    assert.equal(state.pairs.length, 0);
    const analysis = analyze(bank, ledger, state);
    assert.equal(analysis.pairs.length, 0);
    assert.equal(analysis.suggestions[0].confidence, "High");
    assert.equal(initial.pairs.length, 1);
  });

  test("undoing confirmed or manual matches restores eligibility according to the original date window", () => {
    const { bank, ledger } = onePair();
    const confirmed = confirmSuggestion(bank, ledger, emptyState(), "bank:1", "ledger:1");
    assert.equal(analyze(bank, ledger, undoMatch(confirmed, "bank:1", "ledger:1")).suggestions.length, 1);
    const far = onePair({}, {}, 120);
    const manual = manualMatch(far.bank, far.ledger, emptyState(), "bank:1", "ledger:1");
    const undone = analyze(far.bank, far.ledger, undoMatch(manual, "bank:1", "ledger:1"));
    assert.equal(undone.unmatchedBank.length, 1);
    assert.equal(undone.suggestions.length, 0);
  });

  test("an explicit manual match overrides an earlier rejection and undo restores its suggestion", () => {
    const { bank, ledger } = onePair();
    const rejected = rejectSuggestion(emptyState(), "bank:1", "ledger:1");
    const manual = manualMatch(bank, ledger, rejected, "bank:1", "ledger:1");
    assert.equal(manual.rejected.length, 0);
    assert.equal(analyze(bank, ledger, undoMatch(manual, "bank:1", "ledger:1")).suggestions.length, 1);
  });

  test("rejecting a matched pair or undoing a nonexistent pair gives a clear error", () => {
    const { bank, ledger } = onePair();
    const manual = manualMatch(bank, ledger, emptyState(), "bank:1", "ledger:1");
    assert.throws(() => rejectSuggestion(manual, "bank:1", "ledger:1"), /already matched.*Undo/);
    assert.throws(() => undoMatch(emptyState(), "bank:1", "ledger:1"), /no longer exists/);
  });

  test("invalid external states cannot double count a transaction or pair incompatible amounts", () => {
    const { bank, ledger } = ambiguous();
    const manual = manualMatch(bank, ledger, emptyState(), "bank:1", "ledger:1");
    const corrupt = { pairs: [manual.pairs[0], { ...manual.pairs[0], ledgerId: "ledger:2" }], rejected: [] };
    assert.throws(() => analyze(bank, ledger, corrupt), /only one confirmed match/);
    assert.throws(() => summarize(bank, ledger, { pairs: corrupt.pairs, suggestions: [], unmatchedBank: [], unmatchedLedger: [], issues: [] }), /only one confirmed match/);
    const changedLedger = dataset("ledger", [transaction("ledger", "1", "10001"), ledger.transactions[1]]);
    assert.throws(() => analyze(bank, changedLedger, manual), /same signed amount/);
  });

  test("pair keys safely distinguish IDs containing delimiters, quotes, and Arabic text", () => {
    assert.notEqual(pairKey("a|b", "c"), pairKey("a", "b|c"));
    assert.notEqual(pairKey("a", "b"), pairKey("b", "a"));
    assert.deepEqual(JSON.parse(pairKey('بنك:"1"', "دفتر|2")), ['بنك:"1"', "دفتر|2"]);
  });
});

describe("totals and source preservation", () => {
  test("suggestion participants are all still unmatched and included in counts and amounts", () => {
    const { bank, ledger } = ambiguous();
    const analysis = analyze(bank, ledger, emptyState());
    const summary = summarize(bank, ledger, analysis);
    assert.equal(summary.matchedCount, 0);
    assert.equal(summary.suggestedCount, 4);
    assert.equal(summary.unmatchedBankCount, 2);
    assert.equal(summary.unmatchedLedgerCount, 2);
    assert.equal(summary.unreconciledBank, BigInt(20000));
    assert.equal(summary.unreconciledLedger, BigInt(20000));
    assert.equal(summary.difference, BigInt(0));
  });

  test("counts signed matched amounts exactly once and preserves the reconciliation identity", () => {
    const { bank, ledger } = files(
      [transaction("bank", "1", "10000", 100, { referenceKey: "deposit" }), transaction("bank", "2", "-2000", 100, { referenceKey: "fee" }), transaction("bank", "3", "3000")],
      [transaction("ledger", "1", "10000", 100, { referenceKey: "deposit" }), transaction("ledger", "2", "-2000", 100, { referenceKey: "fee" }), transaction("ledger", "3", "1000")],
    );
    const summary = summarize(bank, ledger, analyze(bank, ledger, initialReview(bank, ledger)));
    assert.equal(summary.bankTotal, BigInt(11000));
    assert.equal(summary.ledgerTotal, BigInt(9000));
    assert.equal(summary.matchedAmount, BigInt(8000));
    assert.equal(summary.matchedCount, 2);
    assert.equal(summary.unreconciledBank, BigInt(3000));
    assert.equal(summary.unreconciledLedger, BigInt(1000));
    assert.equal(summary.difference, BigInt(2000));
    assert.equal(summary.difference, summary.unreconciledBank - summary.unreconciledLedger);
  });

  test("partial amount flags include invalid amount rows while totals retain all known signed values", () => {
    const { bank, ledger } = files(
      [transaction("bank", "1", "10000", null), transaction("bank", "2", null)],
      [transaction("ledger", "1", "-2000"), transaction("ledger", "2", null)],
    );
    const summary = summarize(bank, ledger, analyze(bank, ledger, emptyState()));
    assert.equal(summary.bankCount, 2);
    assert.equal(summary.ledgerCount, 2);
    assert.equal(summary.bankTotal, BigInt(10000));
    assert.equal(summary.ledgerTotal, BigInt(-2000));
    assert.equal(summary.bankAmountsComplete, false);
    assert.equal(summary.ledgerAmountsComplete, false);
    assert.equal(summary.unmatchedBankCount, 2);
    assert.equal(summary.difference, summary.unreconciledBank - summary.unreconciledLedger);
  });

  test("an invalid date does not by itself mark a known amount subtotal incomplete", () => {
    const { bank, ledger } = files([transaction("bank", "1", "10000", null)], [transaction("ledger", "1", "10000")]);
    const summary = summarize(bank, ledger, analyze(bank, ledger, emptyState()));
    assert.equal(summary.bankAmountsComplete, true);
    assert.equal(summary.ledgerAmountsComplete, true);
    assert.equal(summary.matchedCount, 0);
  });

  test("huge values retain exact cents in matching and differences", () => {
    const huge = "9007199254740993123456789012";
    const { bank, ledger } = files(
      [transaction("bank", "1", huge, 100, { referenceKey: "large" }), transaction("bank", "2", "2")],
      [transaction("ledger", "1", huge, 100, { referenceKey: "large" })],
    );
    const summary = summarize(bank, ledger, analyze(bank, ledger, initialReview(bank, ledger)));
    assert.equal(summary.matchedAmount, BigInt(huge));
    assert.equal(summary.bankTotal, BigInt(huge) + BigInt(2));
    assert.equal(summary.difference, BigInt(2));
  });

  test("empty datasets return consistent zero totals and counts", () => {
    const { bank, ledger } = files([], []);
    const summary = summarize(bank, ledger, analyze(bank, ledger, initialReview(bank, ledger)));
    assert.deepEqual(summary, {
      bankCount: 0, ledgerCount: 0, bankTotal: BigInt(0), ledgerTotal: BigInt(0), matchedCount: 0,
      suggestedCount: 0, unmatchedBankCount: 0, unmatchedLedgerCount: 0, matchedAmount: BigInt(0),
      unreconciledBank: BigInt(0), unreconciledLedger: BigInt(0), difference: BigInt(0),
      bankAmountsComplete: true, ledgerAmountsComplete: true,
    });
  });

  test("matches supplied normalized Arabic keys while retaining original Arabic text", () => {
    const { bank, ledger } = onePair(
      { description: " دَفعة الكهرباء ", descriptionKey: "دفعة الكهرباء", reference: " فاتورة ١٢٣ ", referenceKey: "فاتورة123" },
      { description: "دفعة الكهرباء", descriptionKey: "دفعة الكهرباء", reference: "فاتورة 123", referenceKey: "فاتورة123" },
    );
    const snapshot = structuredClone(bank);
    assert.equal(initialReview(bank, ledger).pairs.length, 1);
    assert.deepEqual(bank, snapshot);
  });

  test("analysis includes source issues without mutating or sharing issue objects", () => {
    const { bank, ledger } = onePair();
    bank.issues = [{ side: "bank", row: 2, severity: "Error", issueType: "invalid-date", description: "Verify the date." }];
    ledger.issues = [{ side: "ledger", row: 3, severity: "Warning", issueType: "whitespace", description: "Whitespace retained." }];
    const analysis = analyze(bank, ledger, emptyState());
    assert.deepEqual(analysis.issues, [...bank.issues, ...ledger.issues]);
    assert.notEqual(analysis.issues[0], bank.issues[0]);
  });

  test("all operations accept frozen inputs and preserve every source and state value", () => {
    const { bank, ledger } = onePair({ description: " 原文 / النقدية ", cells: ["raw", "100.00"], referenceKey: "ref1" }, { referenceKey: "ref1" });
    const bankSnapshot = structuredClone(bank);
    const ledgerSnapshot = structuredClone(ledger);
    deepFreeze(bank);
    deepFreeze(ledger);
    const initial = deepFreeze(initialReview(bank, ledger));
    const initialSnapshot = structuredClone(initial);
    const undone = deepFreeze(undoMatch(initial, "bank:1", "ledger:1"));
    const undoneSnapshot = structuredClone(undone);
    const confirmed = deepFreeze(confirmSuggestion(bank, ledger, undone, "bank:1", "ledger:1"));
    summarize(bank, ledger, analyze(bank, ledger, confirmed));
    const rejected = deepFreeze(rejectSuggestion(undone, "bank:1", "ledger:1"));
    const rejectedSnapshot = structuredClone(rejected);
    manualMatch(bank, ledger, rejected, "bank:1", "ledger:1");
    assert.deepEqual(bank, bankSnapshot);
    assert.deepEqual(ledger, ledgerSnapshot);
    assert.deepEqual(initial, initialSnapshot);
    assert.deepEqual(undone, undoneSnapshot);
    assert.deepEqual(rejected, rejectedSnapshot);
  });
});

describe("candidate limits and invalid dataset guards", () => {
  test("permits exactly the candidate limit but stops a larger ambiguous graph with a clear message", () => {
    assert.equal(MAX_CANDIDATES, 100000);
    const atLimit = files(
      Array.from({ length: 250 }, (_, index) => transaction("bank", String(index))),
      Array.from({ length: 400 }, (_, index) => transaction("ledger", String(index))),
    );
    assert.equal(analyze(atLimit.bank, atLimit.ledger, emptyState()).suggestions.length, MAX_CANDIDATES);
    const overLimit = files(
      Array.from({ length: 317 }, (_, index) => transaction("bank", String(index))),
      Array.from({ length: 317 }, (_, index) => transaction("ledger", String(index))),
    );
    assert.throws(() => initialReview(overLimit.bank, overLimit.ledger), /over 100,000 candidate pairs.*Split the files/);
  });

  test("same amounts far outside the window create no candidate graph", () => {
    const { bank, ledger } = files(
      Array.from({ length: 500 }, (_, index) => transaction("bank", String(index), "10000", 100)),
      Array.from({ length: 500 }, (_, index) => transaction("ledger", String(index), "10000", 120)),
    );
    assert.equal(initialReview(bank, ledger).pairs.length, 0);
    assert.equal(analyze(bank, ledger, emptyState()).suggestions.length, 0);
  });

  test("missing or duplicate transaction IDs and incorrect sides cannot silently match", () => {
    const { bank, ledger } = onePair();
    assert.throws(() => initialReview(dataset("bank", [bank.transactions[0], bank.transactions[0]]), ledger), /duplicate transaction identifiers/);
    assert.throws(() => initialReview(dataset("bank", [{ ...bank.transactions[0], id: "" }]), ledger), /missing or duplicate transaction identifiers/);
    assert.throws(() => initialReview(dataset("bank", [{ ...bank.transactions[0], side: "ledger" }]), ledger), /bank file on the bank side/);
  });
});


test("description confidence includes an exact 0.8 Dice boundary but not a lower similarity", () => {
  const exact = onePair({ descriptionKey: "abcdef" }, { descriptionKey: "abcdeg" });
  assert.equal(initialReview(exact.bank, exact.ledger).pairs.length, 1);
  assert.match(initialReview(exact.bank, exact.ledger).pairs[0].reason, /similarity 80%/);
  const lower = onePair({ descriptionKey: "abcdef" }, { descriptionKey: "abcdxy" });
  assert.equal(initialReview(lower.bank, lower.ledger).pairs.length, 0);
  assert.equal(analyze(lower.bank, lower.ledger, emptyState()).suggestions[0].confidence, "Possible");
});

test("empty normalized dates and unsafe or fractional day values are ineligible", () => {
  for (const extra of [{ date: "" }, { day: 100.5 }, { day: Number.POSITIVE_INFINITY }, { day: Number.MAX_SAFE_INTEGER + 1 }]) {
    const { bank, ledger } = onePair(extra);
    assert.equal(analyze(bank, ledger, emptyState()).suggestions.length, 0);
    assert.throws(() => manualMatch(bank, ledger, emptyState(), "bank:1", "ledger:1"), /valid dates and amounts/);
  }
});

test("a stale automatic match outside the date window fails validation", () => {
  const { bank, ledger } = onePair({ referenceKey: "ref1" }, { referenceKey: "ref1" });
  const state = initialReview(bank, ledger);
  const shiftedLedger = dataset("ledger", [transaction("ledger", "1", "10000", 120, { referenceKey: "ref1" })]);
  assert.throws(() => analyze(bank, shiftedLedger, state), /within the 3-day date window/);
});
