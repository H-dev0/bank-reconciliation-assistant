"use client";

import { useMemo, useRef, useState } from "react";
import { decodeCsvBytes, MAX_FILE_BYTES, parseCsv } from "@/lib/csv";
import { mappingProblems, suggestMapping } from "@/lib/mapping";
import { buildDataset, normalizeDescription } from "@/lib/normalize";
import { formatAmount } from "@/lib/money";
import { analyze, confirmSuggestion, initialReview, manualMatch, rejectSuggestion, summarize, undoMatch } from "@/lib/engine";
import { downloadCsv, reconciliationReportCsv, summaryReportCsv, unmatchedReportCsv } from "@/lib/reports";
import type { Candidate, ConfirmedPair, DataIssue, Dataset, Mapping, ParsedCsv, ReviewState, Side, Transaction } from "@/lib/types";

type Uploaded = { source: ParsedCsv; mapping: Mapping };
type Tab = "All" | "Matched" | "Suggested" | "Bank Unmatched" | "Ledger Unmatched" | "Data Issues";
type ReviewItem = { kind: "matched"; pair: ConfirmedPair } | { kind: "suggested"; pair: Candidate } | { kind: "bank" | "ledger"; transaction: Transaction } | { kind: "issue"; issue: DataIssue };
const PAGE_SIZE = 20;
const sideName = (side: Side) => side === "bank" ? "Bank" : "Ledger";
const money = (amount: bigint) => {
  const [whole, fraction] = formatAmount(amount).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
};

function Icon({ name }: { name: "upload" | "shield" | "download" | "arrow" }) {
  const paths = { upload: "M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6", shield: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Zm-4 9 3 3 5-6", download: "M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4", arrow: "M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4" };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}

function DatasetPanel({ side, uploaded, loading, error, onFiles, onMapping }: { side: Side; uploaded: Uploaded | null; loading: boolean; error: string; onFiles: (files: File[]) => void; onMapping: (mapping: Mapping) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [previewPage, setPreviewPage] = useState(0);
  const source = uploaded?.source;
  const mapping = uploaded?.mapping;
  const fields = mapping ? [
    {key:"date",label:"Date",value:mapping.date,required:true},
    ...(mapping.format === "signed" ? [{key:"amount",label:"Amount",value:mapping.amount,required:true}] : [{key:"debit",label:"Debit",value:mapping.debit,required:true},{key:"credit",label:"Credit",value:mapping.credit,required:true}]),
    {key:"description",label:"Description",value:mapping.description,required:false},
    {key:"reference",label:"Reference / Transaction ID",value:mapping.reference,required:false},
    ...(side === "ledger" ? [{key:"account",label:"Account / Category",value:mapping.account,required:false}] : []),
  ] : [];
  const problems = source && mapping ? mappingProblems(source.headers,mapping) : [];
  function load(files: File[]) { setDragging(false); setPreviewPage(0); onFiles(files); }
  function changeFormat(format: Mapping["format"]) {
    if (!source || !mapping) return;
    onMapping({...suggestMapping(source.headers,side,format),date:mapping.date,dateFormat:mapping.dateFormat,description:mapping.description,reference:mapping.reference,account:mapping.account});
  }
  return <section className="card dataset-card" aria-labelledby={`${side}-heading`}>
    <div className="card-heading"><div><p className="eyebrow">{side === "bank" ? "01 · BANK STATEMENT" : "02 · COMPANY LEDGER"}</p><h2 id={`${side}-heading`}>{sideName(side)} CSV</h2></div><span className="tag">LOCAL FILE</span></div>
    <input ref={input} id={`${side}-upload`} className="file-input" type="file" accept=".csv,text/csv" aria-label={`Upload ${sideName(side)} CSV`} disabled={loading} onChange={(event)=>{if(event.target.files)load(Array.from(event.target.files));event.target.value="";}} />
    {error && <div role="alert" className="notice error">{error}</div>}
    {!source ? <div role="button" tabIndex={loading ? -1 : 0} aria-label={`Choose or drop ${sideName(side)} CSV`} aria-disabled={loading} className={`drop-zone ${dragging ? "dragging" : ""}`} onClick={()=>{if(!loading)input.current?.click();}} onKeyDown={event=>{if(!loading&&(event.key==="Enter"||event.key===" ")){event.preventDefault();input.current?.click();}}} onDragOver={event=>{event.preventDefault();if(!loading)setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={event=>{event.preventDefault();if(!loading)load(Array.from(event.dataTransfer.files));}}><span className="upload-icon"><Icon name="upload" /></span><strong>{loading ? "Reading CSV…" : `Drop your ${side} CSV here`}</strong><span>or click to choose a file</span><small>UTF-8 CSV · up to 5 MB</small></div> : <>
      <div className="file-bar"><div><strong title={source.filename}>{source.filename}</strong><span>{source.rows.length.toLocaleString()} records · {source.headers.length} columns</span></div><button className="text-button" onClick={()=>input.current?.click()} disabled={loading} type="button">Replace file</button></div>
      <div className="detected-headers"><span>Detected headers</span><div>{source.headers.map((header,index)=><span className="header-chip" key={index}>{index+1}. <bdi>{header||"(unnamed)"}</bdi></span>)}</div></div>
      {mapping && <><div className="mapping-settings"><label>Amount format<select disabled={loading} aria-label={`${sideName(side)} amount format`} value={mapping.format} onChange={event=>changeFormat(event.target.value as Mapping["format"])}><option value="signed">Signed Amount</option><option value="debit-credit">Debit / Credit</option></select></label><label>Date format<select disabled={loading} aria-label={`${sideName(side)} date format`} value={mapping.dateFormat} onChange={event=>onMapping({...mapping,dateFormat:event.target.value as Mapping["dateFormat"]})}><option value="iso">YYYY-MM-DD (ISO)</option><option value="dmy">DD/MM/YYYY</option><option value="mdy">MM/DD/YYYY</option></select></label><label>{mapping.format === "signed" ? "Positive amount represents" : "Debit represents"}<select disabled={loading} aria-label={`${sideName(side)} amount direction`} value={mapping.sign} onChange={event=>onMapping({...mapping,sign:Number(event.target.value) as 1|-1})}><option value={1}>Money in (+)</option><option value={-1}>Money out (−)</option></select></label></div>
      <div className="mapping-fields">{fields.map(field=><div key={field.key}><label htmlFor={`${side}-map-${field.key}`}>{field.label}{!field.required&&<small>Optional</small>}</label><select disabled={loading} id={`${side}-map-${field.key}`} value={field.value} onChange={event=>onMapping({...mapping,[field.key]:Number(event.target.value)} as Mapping)}><option value={-1}>{field.required?"Select column…":"Not mapped"}</option>{source.headers.map((header,index)=><option key={index} value={index}>{index+1} · {header||"Unnamed column"}</option>)}</select></div>)}</div>
      <p className="interpretation">Amounts are normalized to <strong>inflow (+) / outflow (−)</strong>. {mapping.format==="debit-credit" ? "Leave the unused side blank; both-filled or negative debit/credit rows need correction in the source." : "Use negative amounts for the opposite direction."} Decimal amounts round to cents, halfway away from zero. Original values stay unchanged.</p>
      {problems.length>0&&<div className="notice warning"><strong>Complete the mapping</strong><ul>{problems.map(problem=><li key={problem}>{problem}</li>)}</ul></div>}</>}
      <details className="source-preview" open><summary>{sideName(side)} source preview <span>Original values</span></summary><div className="table-scroll"><table aria-label={`${sideName(side)} source preview`}><thead><tr><th>Row</th>{source.headers.map((header,index)=><th key={index}><bdi>{header||`Column ${index+1}`}</bdi></th>)}</tr></thead><tbody>{source.rows.slice(previewPage*10,(previewPage+1)*10).map(row=><tr key={row.row}><td>{row.row}</td>{Array.from({length:Math.max(source.headers.length,row.cells.length)},(_,i)=><td key={i}><span dir="auto" className="cell-value">{row.cells[i]??""}</span></td>)}</tr>)}</tbody></table></div><div className="pager"><span>{previewPage*10+1}–{Math.min((previewPage+1)*10,source.rows.length)} of {source.rows.length}</span><div><button type="button" aria-label={`Previous ${side} preview`} disabled={previewPage===0} onClick={()=>setPreviewPage(previewPage-1)}>Previous</button><button type="button" aria-label={`Next ${side} preview`} disabled={(previewPage+1)*10>=source.rows.length} onClick={()=>setPreviewPage(previewPage+1)}>Next</button></div></div></details>
    </>}
    <a className="sample-link" href={`/sample-${side}.csv`} download={`sample-${side}.csv`}><Icon name="download" />Download sample {side} CSV</a>
  </section>;
}

function TransactionDetail({ transaction, side }: { transaction: Transaction; side: Side }) {
  return <div className={`transaction-detail ${side}`}><p className="eyebrow">{sideName(side).toUpperCase()} · ROW {transaction.row}</p><div className="transaction-top"><time>{transaction.date||transaction.rawDate||"Missing date"}</time><strong>{transaction.amount===null ? transaction.rawAmount||"Missing amount" : money(transaction.amount)}</strong></div><p className="description" dir="auto">{transaction.description||"No description"}</p><div className="transaction-meta"><span>Reference <bdi>{transaction.reference||"—"}</bdi></span>{transaction.account&&<span>Account <bdi>{transaction.account}</bdi></span>}</div><details className="raw-record"><summary>Inspect original record</summary><p dir="auto">{transaction.cells.map((value,index)=><span key={index}><b>{index+1}:</b> <span className="cell-value">{value||"(blank)"}</span></span>)}</p></details></div>;
}

function PairCard({ pair, kind, bank, ledger, onConfirm, onReject, onUndo }: { pair: Candidate|ConfirmedPair; kind:"matched"|"suggested"; bank:Transaction; ledger:Transaction; onConfirm:()=>void; onReject:()=>void; onUndo:()=>void }) {
  const status=kind==="suggested"?"SUGGESTED":("kind" in pair&&pair.kind==="auto"?"AUTO MATCHED":"kind" in pair&&pair.kind==="manual"?"MANUAL MATCHED":"CONFIRMED");
  return <article className={`pair-card ${kind}`} data-bank={bank.row} data-ledger={ledger.row}><div className="pair-heading"><span className={`status-chip ${kind}`}>{status}</span><span>{pair.confidence} signal · {pair.dateDifference} day{pair.dateDifference===1?"":"s"} apart</span></div><div className="pair-sides"><TransactionDetail transaction={bank} side="bank"/><TransactionDetail transaction={ledger} side="ledger"/></div><div className="pair-footer"><p>{pair.reason}</p><div>{kind==="suggested"?<><button className="button primary small" type="button" onClick={onConfirm} aria-label={`Confirm bank row ${bank.row} with ledger row ${ledger.row}`}>Confirm match</button><button className="button secondary small" type="button" onClick={onReject} aria-label={`Reject bank row ${bank.row} with ledger row ${ledger.row}`}>Reject</button></>:<button className="button secondary small" type="button" onClick={onUndo} aria-label={`Undo bank row ${bank.row} with ledger row ${ledger.row}`}>Undo match</button>}</div></div></article>;
}

export default function Home() {
  const [uploads,setUploads]=useState<Record<Side,Uploaded|null>>({bank:null,ledger:null});
  const [reading,setReading]=useState<Record<Side,boolean>>({bank:false,ledger:false});
  const [fileErrors,setFileErrors]=useState<Record<Side,string>>({bank:"",ledger:""});
  const readVersions=useRef({bank:0,ledger:0});
  const [run,setRun]=useState<{bank:Dataset;ledger:Dataset}|null>(null);
  const [review,setReview]=useState<ReviewState>({pairs:[],rejected:[]});
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [tab,setTab]=useState<Tab>("All");
  const [search,setSearch]=useState("");
  const [from,setFrom]=useState("");
  const [to,setTo]=useState("");
  const [page,setPage]=useState(0);
  const [manualBank,setManualBank]=useState("");
  const [manualLedger,setManualLedger]=useState("");
  const analysis=useMemo(()=>run?analyze(run.bank,run.ledger,review):null,[run,review]);
  const summary=useMemo(()=>run&&analysis?summarize(run.bank,run.ledger,analysis):null,[run,analysis]);
  const transactions=useMemo(()=>new Map((run?[...run.bank.transactions,...run.ledger.transactions]:[]).map(transaction=>[transaction.id,transaction])),[run]);
  const canRun=!!uploads.bank&&!!uploads.ledger&&!reading.bank&&!reading.ledger&&!busy&&mappingProblems(uploads.bank.source.headers,uploads.bank.mapping).length===0&&mappingProblems(uploads.ledger.source.headers,uploads.ledger.mapping).length===0;
  const filtered=useMemo(()=>{
    if(!analysis)return [];
    const items:ReviewItem[]=[];
    if(tab==="All"||tab==="Matched")items.push(...analysis.pairs.map(pair=>({kind:"matched" as const,pair})));
    if(tab==="All"||tab==="Suggested")items.push(...analysis.suggestions.map(pair=>({kind:"suggested" as const,pair})));
    if(tab==="All"||tab==="Bank Unmatched")items.push(...analysis.unmatchedBank.map(transaction=>({kind:"bank" as const,transaction})));
    if(tab==="All"||tab==="Ledger Unmatched")items.push(...analysis.unmatchedLedger.map(transaction=>({kind:"ledger" as const,transaction})));
    if(tab==="All"||tab==="Data Issues")items.push(...analysis.issues.map(issue=>({kind:"issue" as const,issue})));
    const term=normalizeDescription(search);
    return items.filter(item=>{
      const rows=item.kind==="matched"||item.kind==="suggested"?[transactions.get(item.pair.bankId)!,transactions.get(item.pair.ledgerId)!]:item.kind==="issue"?[transactions.get(`${item.issue.side}:${item.issue.row}`)].filter((row):row is Transaction=>!!row):[item.transaction];
      if(term&&!rows.some(row=>normalizeDescription(`${row.description} ${row.reference} ${row.account}`).includes(term))&&!(item.kind==="issue"&&normalizeDescription(item.issue.description).includes(term)))return false;
      if((from||to)&&!rows.some(row=>row.date&&(!from||row.date>=from)&&(!to||row.date<=to)))return false;
      return true;
    });
  },[analysis,tab,search,from,to,transactions]);
  function clearResults(){setRun(null);setReview({pairs:[],rejected:[]});setError("");setPage(0);setTab("All");setSearch("");setFrom("");setTo("");setManualBank("");setManualLedger("");}
  async function load(side:Side,files:File[]){
    if(files.length!==1){setFileErrors(old=>({...old,[side]:"Choose one CSV file for this dataset."}));return;}
    const file=files[0];
    if(!file.name.toLowerCase().endsWith(".csv")){setFileErrors(old=>({...old,[side]:"Choose a .csv file. XLSX, PDF and other formats are not supported."}));return;}
    if(file.size>MAX_FILE_BYTES){setFileErrors(old=>({...old,[side]:"File exceeds the 5 MB limit."}));return;}
    const version=++readVersions.current[side];setReading(old=>({...old,[side]:true}));setFileErrors(old=>({...old,[side]:""}));clearResults();
    try{const source=parseCsv(decodeCsvBytes(await file.arrayBuffer()),file.name);if(version!==readVersions.current[side])return;setUploads(old=>({...old,[side]:{source,mapping:suggestMapping(source.headers,side)}}));}
    catch(cause){if(version===readVersions.current[side]){setFileErrors(old=>({...old,[side]:cause instanceof Error?cause.message:"Cannot read this CSV."}));setUploads(old=>({...old,[side]:null}));}}
    finally{if(version===readVersions.current[side])setReading(old=>({...old,[side]:false}));}
  }
  function reset(){readVersions.current.bank++;readVersions.current.ledger++;setUploads({bank:null,ledger:null});setReading({bank:false,ledger:false});setFileErrors({bank:"",ledger:""});clearResults();}
  async function reconcile(){
    if(!canRun||!uploads.bank||!uploads.ledger)return;
    setBusy(true);setError("");await new Promise(resolve=>setTimeout(resolve,0));
    try{const bank=buildDataset(uploads.bank.source,uploads.bank.mapping,"bank");const ledger=buildDataset(uploads.ledger.source,uploads.ledger.mapping,"ledger");const initial=initialReview(bank,ledger);setRun({bank,ledger});setReview(initial);setPage(0);setTab("All");requestAnimationFrame(()=>document.getElementById("results")?.scrollIntoView({behavior:"smooth",block:"start"}));}
    catch(cause){setError(cause instanceof Error?cause.message:"Reconciliation could not run. Check your mappings.");}
    finally{setBusy(false);}
  }
  function action(fn:()=>ReviewState){try{setReview(fn());setError("");setPage(0);setManualBank("");setManualLedger("");}catch(cause){setError(cause instanceof Error?cause.message:"Could not update the match.");}}
  function changeTab(choice:Tab){setTab(choice);setPage(0);}
  const counts:Record<Tab,number>=analysis?{All:analysis.pairs.length+analysis.suggestions.length+analysis.unmatchedBank.length+analysis.unmatchedLedger.length+analysis.issues.length,Matched:analysis.pairs.length,Suggested:analysis.suggestions.length,"Bank Unmatched":analysis.unmatchedBank.length,"Ledger Unmatched":analysis.unmatchedLedger.length,"Data Issues":analysis.issues.length}:{All:0,Matched:0,Suggested:0,"Bank Unmatched":0,"Ledger Unmatched":0,"Data Issues":0};
  function candidateOption(transaction:Transaction){return `Row ${transaction.row} · ${transaction.date??"Invalid date"} · ${transaction.amount===null?"Invalid amount":money(transaction.amount)} · ${transaction.description||transaction.reference||"No description"}`;}
  function downloadReports(kind:"report"|"bank"|"ledger"|"summary"){
    if(!run||!analysis||!summary)return;
    if(kind==="report")downloadCsv("reconciliation-report.csv",reconciliationReportCsv(run.bank,run.ledger,analysis));
    if(kind==="bank")downloadCsv("unmatched-bank.csv",unmatchedReportCsv(analysis.unmatchedBank));
    if(kind==="ledger")downloadCsv("unmatched-ledger.csv",unmatchedReportCsv(analysis.unmatchedLedger));
    if(kind==="summary")downloadCsv("reconciliation-summary.csv",summaryReportCsv(summary));
  }
  return <main className="shell"><header className="app-header"><div className="brand"><span className="brand-mark"><Icon name="arrow"/></span><div><p className="eyebrow">LOCAL-FIRST · ACCOUNTING TOOLS</p><h1>Bank Reconciliation Assistant</h1><p className="subtitle">Compare the bank. Review the ledger. Resolve the difference.</p></div></div><button type="button" className="button secondary" onClick={reset} disabled={busy||reading.bank||reading.ledger||(!uploads.bank&&!uploads.ledger&&!fileErrors.bank&&!fileErrors.ledger)}>Start Over</button></header>
    <div className="privacy"><Icon name="shield"/><span><strong>Your financial data stays in this browser.</strong> No server upload, analytics, database, or external services. Refreshing clears your work.</span></div>
    <nav className="steps" aria-label="Progress">{["Upload files","Map & preview","Reconcile","Review & export"].map((step,index)=><span key={step} className={analysis?index===3?"active":"":index===0&&!uploads.bank&&!uploads.ledger||index===1&&(!!uploads.bank||!!uploads.ledger)?"active":""}><b>{index+1}</b>{step}</span>)}</nav>
    <div className="datasets">{(["bank","ledger"] as const).map(side=><DatasetPanel key={`${side}-${uploads[side]?.source.filename??"empty"}`} side={side} uploaded={uploads[side]} loading={reading[side]||busy} error={fileErrors[side]} onFiles={files=>void load(side,files)} onMapping={mapping=>{setUploads(old=>old[side]?{...old,[side]:{...old[side],mapping}}:old);clearResults();}}/>)}</div>
    {!analysis&&<div className="run-bar"><div><h2>Ready to compare?</h2><p>Exact amounts · posting dates within ±3 days · reference and description signals.<br/>Ambiguous matches stay suggestions until you review them.</p></div><button type="button" className="button primary" onClick={()=>void reconcile()} disabled={!canRun}>{busy?"Reconciling…":"Run Reconciliation"}</button></div>}
    {error&&<div className="notice error" role="alert">{error}</div>}
    {analysis&&summary&&run&&<section id="results" className="results" aria-labelledby="results-heading"><div className="section-heading"><div><p className="eyebrow">RECONCILIATION WORKSPACE</p><h2 id="results-heading">Review your results</h2></div><span className="tag">DATE WINDOW ±3 DAYS</span></div>
      <div className="total-grid"><article className="metric"><span>Bank transactions</span><strong data-testid="bank-count">{summary.bankCount}</strong><small>Non-empty source records</small></article><article className="metric"><span>Bank total amount</span><strong data-testid="bank-total">{money(summary.bankTotal)}</strong><small>{summary.bankAmountsComplete?"Signed total":"Partial · invalid amounts excluded"}</small></article><article className="metric"><span>Ledger transactions</span><strong data-testid="ledger-count">{summary.ledgerCount}</strong><small>Non-empty source records</small></article><article className="metric"><span>Ledger total amount</span><strong data-testid="ledger-total">{money(summary.ledgerTotal)}</strong><small>{summary.ledgerAmountsComplete?"Signed total":"Partial · invalid amounts excluded"}</small></article></div>
      <div className={`difference-panel ${summary.unmatchedBankCount===0&&summary.unmatchedLedgerCount===0&&analysis.issues.every(issue=>issue.severity!=="Error")?"complete":""}`}><div><span>Reconciliation Difference</span><strong data-testid="difference">{money(summary.difference)}</strong></div><p><strong>Bank signed total − Ledger signed total</strong><br/>Also equals unreconciled Bank − unreconciled Ledger. A zero net difference can hide offsetting unmatched items. Reconciliation does not establish accounting correctness.{(!summary.bankAmountsComplete||!summary.ledgerAmountsComplete)&&<b className="partial-note"> Difference is partial because some amounts are invalid or missing.</b>}</p></div>
      <div className="count-grid">{[{title:"Matched pairs",value:summary.matchedCount,id:"matched-count"},{title:"Suggested pairs",value:summary.suggestedCount,id:"suggested-count"},{title:"Unmatched Bank",value:summary.unmatchedBankCount,id:"unmatched-bank-count"},{title:"Unmatched Ledger",value:summary.unmatchedLedgerCount,id:"unmatched-ledger-count"}].map(metric=><article className="metric" key={metric.id}><span>{metric.title}</span><strong data-testid={metric.id}>{metric.value}</strong></article>)}</div>
      <div className="amount-strip"><div><span>Matched amount</span><strong data-testid="matched-amount">{money(summary.matchedAmount)}</strong></div><div><span>Unreconciled Bank</span><strong data-testid="unreconciled-bank">{money(summary.unreconciledBank)}</strong></div><div><span>Unreconciled Ledger</span><strong data-testid="unreconciled-ledger">{money(summary.unreconciledLedger)}</strong></div></div><p className="summary-note">Amounts are signed net flows. Matched amount counts each Bank pair once. Unmatched includes rows awaiting suggestion review; suggested count counts candidate pairs. Invalid amounts are excluded from totals.</p>
      <section className="card manual-card" aria-labelledby="manual-heading"><div className="card-heading"><div><h3 id="manual-heading">Match manually</h3><p>Choose two unpaired rows with the same normalized amount. Manual review may override the ±3-day window.</p></div><span className="tag">ONE-TO-ONE</span></div><div className="manual-fields"><label>Bank transaction<select aria-label="Manual bank transaction" value={manualBank} onChange={event=>setManualBank(event.target.value)}><option value="">Choose bank row…</option>{analysis.unmatchedBank.map(transaction=><option key={transaction.id} value={transaction.id} disabled={transaction.amount===null||transaction.day===null}>{candidateOption(transaction)}</option>)}</select></label><label>Ledger transaction<select aria-label="Manual ledger transaction" value={manualLedger} onChange={event=>setManualLedger(event.target.value)}><option value="">Choose ledger row…</option>{analysis.unmatchedLedger.map(transaction=><option key={transaction.id} value={transaction.id} disabled={transaction.amount===null||transaction.day===null}>{candidateOption(transaction)}</option>)}</select></label><button type="button" className="button primary" disabled={!manualBank||!manualLedger} onClick={()=>action(()=>manualMatch(run.bank,run.ledger,review,manualBank,manualLedger))}>Match selected rows</button></div></section>
      <section className="card review-card" aria-labelledby="review-heading"><div className="card-heading"><div><h3 id="review-heading">Transactions & findings</h3><p>High confidence is a deterministic signal classification, not a probability.</p></div></div><div className="tabs" role="group" aria-label="Result filters">{(Object.keys(counts) as Tab[]).map(choice=><button type="button" key={choice} aria-pressed={tab===choice} onClick={()=>changeTab(choice)}>{choice}<span>{counts[choice]}</span></button>)}</div><div className="search-filters"><label>Search description / reference<input type="search" placeholder="Search transactions…" value={search} onChange={event=>{setSearch(event.target.value);setPage(0);}}/></label><label>From date<input type="date" value={from} onChange={event=>{setFrom(event.target.value);setPage(0);}}/></label><label>To date<input type="date" value={to} onChange={event=>{setTo(event.target.value);setPage(0);}}/></label></div><p className="filter-note">Filters affect this view only. Totals and exports always include the full analysis.</p>{from&&to&&from>to&&<p className="notice warning">From date must be on or before To date.</p>}
      <div className="review-items">{filtered.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE).map((item,index)=>item.kind==="matched"||item.kind==="suggested"?<PairCard key={`${item.kind}-${item.pair.bankId}-${item.pair.ledgerId}`} pair={item.pair} kind={item.kind} bank={transactions.get(item.pair.bankId)!} ledger={transactions.get(item.pair.ledgerId)!} onConfirm={()=>action(()=>confirmSuggestion(run.bank,run.ledger,review,item.pair.bankId,item.pair.ledgerId))} onReject={()=>action(()=>rejectSuggestion(review,item.pair.bankId,item.pair.ledgerId))} onUndo={()=>action(()=>undoMatch(review,item.pair.bankId,item.pair.ledgerId))}/>:item.kind==="issue"?<article className="issue-card" key={`issue-${item.issue.side}-${item.issue.row}-${index}`}><div><span className={`severity ${item.issue.severity.toLowerCase()}`}>{item.issue.severity}</span><strong>{sideName(item.issue.side)} · Row {item.issue.row}</strong><span>{item.issue.issueType.replaceAll("-"," ")}</span></div><p>{item.issue.description}</p>{transactions.get(`${item.issue.side}:${item.issue.row}`)&&<details><summary>Inspect affected record</summary><TransactionDetail transaction={transactions.get(`${item.issue.side}:${item.issue.row}`)!} side={item.issue.side}/></details>}</article>:<article className="unmatched-card" key={item.transaction.id}><div className="pair-heading"><span className="status-chip unmatched">{sideName(item.transaction.side).toUpperCase()} UNMATCHED</span><span>{analysis.suggestions.some(pair=>pair.bankId===item.transaction.id||pair.ledgerId===item.transaction.id)?"Suggestion awaiting review":"No active suggestion"}</span></div><TransactionDetail transaction={item.transaction} side={item.transaction.side}/></article>)}</div>
      {!filtered.length&&<div className="empty-results">No items in this view. Choose another filter or clear your search.</div>}
      <div className="pager"><span>{filtered.length?`${page*PAGE_SIZE+1}–${Math.min((page+1)*PAGE_SIZE,filtered.length)} of ${filtered.length}`:"0 items"}</span><div><button type="button" aria-label="Previous results" disabled={page===0} onClick={()=>setPage(page-1)}>Previous</button><span>{page+1} / {Math.max(1,Math.ceil(filtered.length/PAGE_SIZE))}</span><button type="button" aria-label="Next results" disabled={(page+1)*PAGE_SIZE>=filtered.length} onClick={()=>setPage(page+1)}>Next</button></div></div></section>
      <section className="exports"><div><h3>Download your reconciliation</h3><p>UTF-8 CSV with BOM for Arabic in Excel. Suggestions are proposals, not confirmed pairs. Unmatched exports include all unpaired rows.</p></div><div className="export-buttons"><button className="button primary" type="button" onClick={()=>downloadReports("report")}>Download Reconciliation Report CSV</button><button className="button secondary" type="button" onClick={()=>downloadReports("bank")}>Download Unmatched Bank CSV</button><button className="button secondary" type="button" onClick={()=>downloadReports("ledger")}>Download Unmatched Ledger CSV</button><button className="button secondary" type="button" onClick={()=>downloadReports("summary")}>Download Summary CSV</button></div></section>
    </section>}
    <footer><span>Assists reconciliation. Does not replace accounting review.</span><span lang="ar" dir="rtl">بياناتك المالية تبقى في متصفحك.</span></footer>
  </main>;
}
