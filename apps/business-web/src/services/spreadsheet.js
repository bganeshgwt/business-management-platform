// A spreadsheet read into the rows an import sends: { heading: cell }, the
// headings exactly as typed, one row for every line under the heading line
// (an empty line too, so a row's number is its line in the spreadsheet).
// A CSV file is read by the app's one CSV reader; an Excel workbook (.xlsx)
// by read-excel-file (MIT, read only), loaded only when one is chosen. Each
// cell becomes the text its CSV would hold: numbers as written, a date as
// 2027-12-31, a tick box as yes or no. Formulas give the value Excel worked
// out. Kept in the browser, so the server checks the same rows either way.

import { parseCsv } from "./csv.js";

// The largest file the imports read (their request is 5 MB at most).
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const isCsvFile = (file) => /\.csv$/i.test(file.name) || file.type === "text/csv";
export const isExcelFile = (file) => /\.xlsx$/i.test(file.name) || file.type === XLSX_TYPE;
// Excel 97-2003 workbooks (.xls) are another format, not read here.
export const isOldExcelFile = (file) => /\.xls$/i.test(file.name) || file.type === "application/vnd.ms-excel";
export const EXCEL_ACCEPT = `.xlsx,${XLSX_TYPE}`;

const two = (value) => String(value).padStart(2, "0");

// One cell as the text its CSV would hold. A date is read as a calendar day:
// Excel keeps no time zone, and read-excel-file gives it at midnight UTC.
export function cellText(cell) {
  if (cell === null || cell === undefined) {
    return "";
  }

  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime()) ? "" : `${cell.getUTCFullYear()}-${two(cell.getUTCMonth() + 1)}-${two(cell.getUTCDate())}`;
  }

  if (typeof cell === "boolean") {
    return cell ? "yes" : "no";
  }

  if (typeof cell === "number") {
    return Number.isFinite(cell) ? String(cell) : "";
  }

  return String(cell);
}

// Lines of cells, the heading line first, as { heading: cell } rows.
export function rowsOf(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    return [];
  }

  const headings = lines[0].map((heading) => cellText(heading).trim());

  return lines.slice(1).map((line) => {
    const row = {};

    headings.forEach((heading, index) => {
      if (heading) {
        row[heading] = cellText(line[index]);
      }
    });

    return row;
  });
}

export const readCsvRows = (text) => rowsOf(parseCsv(text));

// Every sheet of a workbook: [{ name, rows }], in the workbook's order.
// `source` is the chosen File (or its bytes); a file that is not an .xlsx
// workbook is refused by the reader.
export async function readWorkbook(source) {
  const { default: readXlsxFile } = await import("read-excel-file/universal");
  const bytes = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
  const sheets = await readXlsxFile(bytes);

  return sheets.map((sheet) => ({ name: String(sheet.sheet), rows: rowsOf(sheet.data) }));
}
