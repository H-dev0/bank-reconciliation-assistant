import Papa from "papaparse";
import type { ParsedCsv } from "./types";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 10_000;
export const MAX_COLUMNS = 100;
export const MAX_CELL_LENGTH = 10_000;

/** Read CSV records without discarding blank records or changing cell text. */
export function parseCsv(text: string, filename: string): ParsedCsv {
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) {
    throw new Error("File is too large. The limit is 5 MB.");
  }
  const source = text.replace(/^\uFEFF/, "");
  if (!source.trim()) throw new Error("The CSV is empty. Include headers and transaction rows.");
  const parsed = Papa.parse<string[]>(source, {
    delimiter: ",", header: false, dynamicTyping: false, skipEmptyLines: false, comments: false,
  });
  if (parsed.errors.length) {
    const first = parsed.errors[0];
    const record = typeof first.row === "number" ? ` near record ${first.row + 1}` : "";
    throw new Error(`Cannot parse CSV${record}. Check commas and matching double quotes.`);
  }
  const records = parsed.data;
  // Remove Papa's synthetic EOF record only; retain physical blank records.
  const last = records.at(-1);
  if (/[\r\n]$/.test(source) && last?.length === 1 && last[0] === "") records.pop();
  const headers = records[0];
  if (!headers || headers.length < 2 || !headers.some((header) => header.trim())) {
    throw new Error("Use a comma-separated CSV with a header row and at least two columns.");
  }
  if (records.some((cells) => cells.length > MAX_COLUMNS)) {
    throw new Error("The CSV has too many columns. The limit is 100.");
  }
  if (records.some((cells) => cells.some((cell) => cell.length > MAX_CELL_LENGTH))) {
    throw new Error("A CSV cell is too long. The limit is 10,000 characters per cell.");
  }
  if (records.length < 2) throw new Error("The CSV contains headers but no data records.");
  if (records.length - 1 > MAX_ROWS) throw new Error("The CSV has too many rows. The limit is 10,000 data records.");
  return {
    filename,
    headers: [...headers],
    rows: records.slice(1).map((cells, index) => ({ row: index + 2, cells: [...cells] })),
  };
}

export function decodeCsvBytes(buffer: ArrayBuffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new Error("This file is not valid UTF-8. Save it as CSV UTF-8 and upload again."); }
}

/** BOM and CSV escaping are applied here; report text shielding belongs to reports. */
export function encodeCsv(rows: readonly (readonly string[])[]): string {
  return "\uFEFF" + rows.map((row) => row.map((cell) =>
    /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell,
  ).join(",")).join("\r\n") + "\r\n";
}
