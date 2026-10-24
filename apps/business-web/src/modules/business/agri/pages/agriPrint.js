import { escapeHtml, printDocument } from "../../../../services/print";
import { dateLong, dateTime } from "@bmp/shared/format";

// The farm-input shop's printouts: the daily stock and price board (large
// print, for display at the shop) and the registers (A4 landscape, a row per
// entry, as an inspector reads them).

const e = escapeHtml;
const PAGE = `body{font-family:Arial,Helvetica,sans-serif;color:#111} h1{margin:0} .muted{color:#555} .small{font-size:10px}
  table{width:100%;border-collapse:collapse} th,td{border:1px solid #999;padding:5px 6px;text-align:left;vertical-align:top} th{background:#eee}
  .r{text-align:right} .top{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #222;padding-bottom:8px;margin-bottom:10px}`;

const sellerLines = (biz, location) => `<strong>${e(biz.settings.display_name || biz.business.name)}</strong>${location ? `<div>${e(location.name)}</div>` : ""}`;

// rows: the board's rows; licences: the licence numbers to show (fertiliser and seed).
export function printBoard({ biz, board, licences = [], money }) {
  const section = (kind, title) => {
    const rows = board.rows.filter((r) => r.input_kind === kind);
    if (!rows.length) return "";
    return `<h2>${e(title)}</h2><table><thead><tr><th>Item</th><th class="r">Opening stock</th>${board.closed ? '<th class="r">Closing stock</th>' : ""}<th class="r">Price</th><th class="r">MRP</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td><strong>${e(r.label)}</strong>${kind === "seed" && (r.seed_crop || r.seed_variety) ? `<div class="small">${e([r.seed_crop, r.seed_variety].filter(Boolean).join(" · "))}</div>` : ""}</td>
        <td class="r">${e(Number(r.opening).toLocaleString("en-IN"))} ${e(r.unit)}</td>${board.closed ? `<td class="r">${e(Number(r.closing).toLocaleString("en-IN"))} ${e(r.unit)}</td>` : ""}
        <td class="r">${e(money(r.price))}</td><td class="r">${r.mrp === null ? "" : e(money(r.mrp))}</td></tr>`).join("")}</tbody></table>`;
  };
  printDocument({
    title: "Stock and price board",
    styles: `@page{size:A4;margin:12mm} ${PAGE} h1{font-size:24px} h2{font-size:18px;margin:16px 0 6px} td,th{font-size:15px;padding:7px 8px}`,
    body: `<div class="top"><div><h1>Stock and price board</h1><div>${e(dateLong(board.on))}</div></div><div class="r">${sellerLines(biz, board.location)}
        ${licences.map((l) => `<div class="small">${e(l.name)}: ${e(l.licence_no)}</div>`).join("")}</div></div>
      ${section("fertiliser", "Fertilisers")}${section("seed", "Seeds")}
      <p class="small muted">${board.taxMode === "inclusive" ? "Prices include GST. " : ""}Opening stock as at the start of ${e(dateLong(board.on))}. Printed ${e(dateTime(new Date()))}.</p>`,
  });
}

// A register: title, the period or month it covers, and its columns as [heading, (row) => text].
export function printRegister({ biz, title, period, location, rows, columns, note }) {
  printDocument({
    title,
    styles: `@page{size:A4 landscape;margin:10mm} ${PAGE} h1{font-size:18px} td,th{font-size:10.5px}`,
    body: `<div class="top"><div><h1>${e(title)}</h1><div class="muted">${e(period || "")}</div></div><div class="r">${sellerLines(biz, location)}</div></div>
      <table><thead><tr><th>S.No.</th>${columns.map(([h]) => `<th>${e(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td>${columns.map(([, f]) => `<td>${e(f(r) ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>
      <p class="small muted">${note ? `${e(note)} ` : ""}${rows.length} entr${rows.length === 1 ? "y" : "ies"} · printed ${e(dateTime(new Date()))}</p>`,
  });
}
