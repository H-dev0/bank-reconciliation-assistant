export type ParsedAmount =
  | { kind: "empty" }
  | { kind: "invalid"; reason: string }
  | { kind: "valid"; cents: bigint; rounded: boolean };

const ZERO = BigInt(0);
const ONE = BigInt(1);
const HUNDRED = BigInt(100);

/** Normalize an amount to cents with exact half-away-from-zero rounding. */
export function parseAmount(input: string): ParsedAmount {
  let value = input.trim();
  if (!value) return { kind: "empty" };
  value = value
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/\u066b/g, ".")
    .replace(/\u066c/g, ",");

  let negative = false;
  if (value.startsWith("(") && value.endsWith(")")) {
    value = value.slice(1, -1).trim();
    negative = true;
    if (/^[+-]/.test(value)) return { kind: "invalid", reason: "Use a sign or parentheses for a negative value, not both." };
  } else if (/^[+-]/.test(value)) {
    negative = value[0] === "-";
    value = value.slice(1);
  }

  const match = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    return { kind: "invalid", reason: "Use digits, optional valid thousands groups, and a decimal point; currency symbols and exponents are unsupported." };
  }
  const [whole, fraction = ""] = value.split(".");
  let cents = BigInt(whole.replace(/,/g, "")) * HUNDRED + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  if (fraction.length > 2 && fraction[2] >= "5") cents += ONE;
  return { kind: "valid", cents: negative ? -cents : cents, rounded: fraction.length > 2 };
}

/** Ungrouped decimal text stays numeric when used in CSV reports. */
export function formatAmount(cents: bigint): string {
  const negative = cents < ZERO;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / HUNDRED}.${(absolute % HUNDRED).toString().padStart(2, "0")}`;
}
