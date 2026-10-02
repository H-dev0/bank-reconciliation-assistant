import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCsv } from "../src/lib/csv";
import { suggestMapping } from "../src/lib/mapping";
import { buildDataset } from "../src/lib/normalize";
import { analyze, initialReview, manualMatch, summarize, undoMatch } from "../src/lib/engine";
import type { Side } from "../src/lib/types";

type Scenario = { name:string;bankFile:string;ledgerFile:string;auto:number;suggestions:number;unmatchedBank:number;unmatchedLedger:number;actions:{type:string;bankRow:number;ledgerRow:number}[] };
const folder=path.join(process.cwd(),"tests","fixtures");
const scenarios=JSON.parse(readFileSync(path.join(folder,"manifest.json"),"utf8")) as Scenario[];
function dataset(filename:string,side:Side,dir=folder){const source=parseCsv(readFileSync(path.join(dir,filename),"utf8"),filename);return buildDataset(source,suggestMapping(source.headers,side),side);}
for(const fixture of scenarios)test(`paired CSV fixture: ${fixture.name}`,()=>{
  const bank=dataset(fixture.bankFile,"bank"); const ledger=dataset(fixture.ledgerFile,"ledger");
  const original=structuredClone({bank:bank.source,ledger:ledger.source});
  let review=initialReview(bank,ledger);let result=analyze(bank,ledger,review);
  assert.equal(result.pairs.length,fixture.auto);assert.equal(result.suggestions.length,fixture.suggestions);
  assert.equal(result.unmatchedBank.length,fixture.unmatchedBank);assert.equal(result.unmatchedLedger.length,fixture.unmatchedLedger);
  if(fixture.name.includes("duplicate"))assert(result.issues.some(issue=>issue.issueType==="duplicate-transaction"));
  if(fixture.name.includes("arabic"))assert.equal(bank.transactions[0].description,"تحويل بنكي");
  for(const action of fixture.actions){
    const bankId=`bank:${action.bankRow}`,ledgerId=`ledger:${action.ledgerRow}`;
    if(action.type==="manual"){review=manualMatch(bank,ledger,review,bankId,ledgerId);assert.equal(review.pairs.length,1);assert.equal(review.pairs[0].kind,"manual");}
    if(action.type==="undo"){review=undoMatch(review,bankId,ledgerId);assert.equal(review.pairs.length,0);assert.equal(analyze(bank,ledger,review).suggestions.length,1);}
    if(action.type==="blocked-manual"){assert.throws(()=>manualMatch(bank,ledger,review,bankId,ledgerId));assert.equal(review.pairs.length,1);}
  }
  result=analyze(bank,ledger,review);const summary=summarize(bank,ledger,result);
  assert.equal(summary.difference,summary.unreconciledBank-summary.unreconciledLedger);
  assert.equal(new Set(result.pairs.map(pair=>pair.bankId)).size,result.pairs.length);
  assert.equal(new Set(result.pairs.map(pair=>pair.ledgerId)).size,result.pairs.length);
  assert.deepEqual({bank:bank.source,ledger:ledger.source},original);
});
test("downloadable samples demonstrate auto, ambiguous, duplicated, unmatched and Arabic rows",()=>{
  const dir=path.join(process.cwd(),"public");const bank=dataset("sample-bank.csv","bank",dir);const ledger=dataset("sample-ledger.csv","ledger",dir);
  const result=analyze(bank,ledger,initialReview(bank,ledger));const summary=summarize(bank,ledger,result);
  assert.equal(result.pairs.length,4);assert.equal(result.suggestions.length,8);
  assert.equal(summary.bankCount,10);assert.equal(summary.ledgerCount,9);
  assert.equal(summary.unmatchedBankCount,6);assert.equal(summary.unmatchedLedgerCount,5);
  assert.equal(summary.bankTotal,221000n);assert.equal(summary.ledgerTotal,217000n);assert.equal(summary.difference,4000n);
  assert(result.issues.some(issue=>issue.side==="bank"&&issue.issueType==="duplicate-transaction"));
  assert(result.issues.some(issue=>issue.side==="ledger"&&issue.issueType==="duplicate-transaction"));
});
