// Reading and writing the CSV files a restaurant opens in Excel. Kept in the
// browser so the API only ever deals in JSON.

// A guest can type "=HYPERLINK(...)" as their name. Excel runs a cell that
// starts with = + - @ (or a tab/return) as a formula, so such text gets a
// leading apostrophe, which makes Excel show it as plain text. Real numbers,
// including negative amounts like -120.50, are left alone.
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

const safeCell = (cell) => {
  const text = String(cell ?? "");

  return typeof cell === "string" && FORMULA_START.test(text) && !PLAIN_NUMBER.test(text)
    ? `'${text}`
    : text;
};

// Wraps every cell in quotes and doubles any quote inside, which is the one
// escaping rule Excel and Google Sheets both follow.
const toCsv = (rows) =>
  rows
    .map((row) => row.map((cell) => `"${safeCell(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");

export const downloadCsv = (rows, filename) => {
  if (rows.length === 0) {
    return;
  }

  const link = document.createElement("a");
  // The BOM makes Excel open a UTF-8 file with rupee signs and accents intact.
  link.href = URL.createObjectURL(
    new Blob(["﻿", toCsv(rows)], { type: "text/csv;charset=utf-8;" })
  );
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
};

// A real parser rather than split(","): a description may hold commas, quotes
// or a line break, and a naive split would silently shift every later column.
export const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  const clean = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];

    if (quoted) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }

      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  // Whatever is left when the text ends is the last cell of the last row.
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((line) => line.some((value) => String(value).trim() !== ""));
};
