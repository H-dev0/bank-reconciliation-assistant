import type { Mapping, Side } from "./types";

const aliases = {
  date: ["date", "transactiondate", "postingdate", "valuedate", "تاريخ", "التاريخ", "تاريخالعملية", "تاريخالحركة", "تاريخالقيد"],
  description: ["description", "details", "memo", "narrative", "transactiondescription", "البيان", "بيان", "الوصف", "وصف", "تفاصيل", "وصفالعملية", "وصفالحركة"],
  reference: ["reference", "ref", "referenceid", "referencenumber", "referenceno", "transactionreference", "transactionid", "txnid", "id", "رقمالمرجع", "المرجع", "مرجع", "رقممرجعي"],
  account: ["account", "accountcode", "accountnumber", "accountno", "glcode", "category", "الفئة", "التصنيف", "الحساب", "رقمالحساب", "رمزالحساب", "كودالحساب"],
  amount: ["amount", "signedamount", "transactionamount", "netamount", "المبلغ", "مبلغ", "القيمة", "قيمة", "مبلغالحركة", "قيمةالحركة"],
  debit: ["debit", "debits", "dr", "withdrawal", "withdrawals", "مدين", "سحب", "المبالغالمدينة"],
  credit: ["credit", "credits", "cr", "deposit", "deposits", "دائن", "إيداع", "ايداع", "المبالغالدائنة"],
};

function findColumn(headers: string[], field: keyof typeof aliases): number {
  const matches: number[] = [];
  headers.forEach((header, index) => {
    const key = header.trim().toLowerCase().replace(/[\s_.-]+/g, "");
    if (aliases[field].includes(key)) matches.push(index);
  });
  return matches.length === 1 ? matches[0] : -1;
}

export function suggestMapping(headers: string[], side: Side, format?: Mapping["format"]): Mapping {
  const date = findColumn(headers, "date");
  const description = findColumn(headers, "description");
  const reference = findColumn(headers, "reference");
  const account = side === "ledger" ? findColumn(headers, "account") : -1;
  const amount = findColumn(headers, "amount");
  const debit = findColumn(headers, "debit");
  const credit = findColumn(headers, "credit");
  const chosen = format ?? (amount === -1 && (debit !== -1 || credit !== -1) ? "debit-credit" : "signed");
  const common = { date, description, reference, account, dateFormat: "iso" as const };
  return chosen === "signed"
    ? { ...common, format: "signed", amount, sign: 1 }
    : { ...common, format: "debit-credit", debit, credit, sign: side === "bank" ? -1 : 1 };
}

export function mappingProblems(headers: string[], mapping: Mapping): string[] {
  const problems: string[] = [];
  const required: [string, number][] = [["Date", mapping.date]];
  if (mapping.format === "signed") required.push(["Amount", mapping.amount]);
  else if (mapping.format === "debit-credit") required.push(["Debit", mapping.debit], ["Credit", mapping.credit]);
  else problems.push("Choose signed amounts or debit/credit columns.");
  const optional: [string, number][] = [["Description", mapping.description], ["Reference", mapping.reference], ["Account", mapping.account]];
  for (const [label, index] of required) {
    if (!Number.isInteger(index) || index < 0 || index >= headers.length) problems.push(`Select a column for ${label}.`);
  }
  for (const [label, index] of optional) {
    if (index !== -1 && (!Number.isInteger(index) || index < 0 || index >= headers.length)) problems.push(`Select a valid column for ${label}, or choose None.`);
  }
  const active = [...required, ...optional].map(([, index]) => index).filter((index) => Number.isInteger(index) && index >= 0 && index < headers.length);
  if (new Set(active).size !== active.length) problems.push("Each mapped field must use a different CSV column.");
  if (!["iso", "dmy", "mdy"].includes(mapping.dateFormat)) problems.push("Choose ISO, day/month/year, or month/day/year dates.");
  if (mapping.sign !== 1 && mapping.sign !== -1) problems.push("Choose a valid amount sign convention.");
  return problems;
}
