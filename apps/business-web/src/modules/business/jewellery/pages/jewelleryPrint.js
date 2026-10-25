import { escapeHtml, printDocument } from "../../../../services/print";
import { dateShort } from "@bmp/shared/format";
import { barcodeSvg } from "../../retail/services/barcode";
import { ID_KINDS, TEST_METHODS, purityMark } from "./jewellery";

// Printing for a jeweller: the tag labels of pieces, each with its tag as a
// barcode, its item, purity, gross and net weight, stones and HUIDs, on a label
// roll or an A4 sheet (no price is printed on a tag: a piece's price follows
// the day's rate); and an old gold voucher for the seller to sign and keep.

const bars = (code, height = 30) => { try { return barcodeSvg(code, { height }).svg; } catch { return ""; } };
const g = (value) => Number(value || 0).toFixed(3);

export const TAG_LAYOUTS = {
  roll: { label: "Label roll · 50 × 25 mm", width: 50, height: 25 },
  a40: { label: "A4 · 40 per sheet (4 × 10, 48.5 × 25.4 mm)", columns: 4, rows: 10, width: 48.5, height: 25.4, top: 21.5, left: 8 },
};

export function printPieceTags(biz, pieces, layout = "roll") {
  const shape = TAG_LAYOUTS[layout] || TAG_LAYOUTS.roll;
  const shop = biz.settings.display_name || biz.business.name;
  const cells = pieces.map((p) => {
    const huids = String(p.huids || "").trim();
    const stones = Number(p.stone_weight) > 0 ? ` · St ${g(p.stone_weight)}` : "";
    return `<div class="lbl"><div class="top"><span>${escapeHtml(shop)}</span><b>${escapeHtml(purityMark(p.metal, p.purity))}</b></div>
      <div class="mid"><div class="tag">${escapeHtml(p.tag_no)}</div><div class="bc">${bars(p.tag_no)}</div></div>
      <div class="foot"><span>G ${g(p.gross_weight)} · N ${g(p.net_weight)} g${stones}</span>${huids ? `<span>HUID ${escapeHtml(huids)}</span>` : ""}</div>
      <div class="svc">${escapeHtml(p.description || p.item_label || "")}</div></div>`;
  });
  const label = ".lbl{box-sizing:border-box;width:100%;height:100%;padding:1.2mm 1.8mm;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;font:6.5pt system-ui;color:#000}"
    + " .top{display:flex;justify-content:space-between;gap:2mm;white-space:nowrap;overflow:hidden} .top b{font-weight:800}"
    + " .mid{display:flex;align-items:center;gap:1.5mm;min-height:0;flex:1} .tag{font:800 12pt ui-monospace,Consolas,monospace;line-height:1} .bc{flex:1;min-width:0;height:8mm} .bc svg{width:100%;height:100%}"
    + " .foot{display:flex;justify-content:space-between;gap:1.5mm;white-space:nowrap;overflow:hidden} .svc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}";
  const title = pieces.length === 1 ? `${pieces[0].tag_no} tag` : `${pieces.length} tags`;
  if (layout === "a40") {
    const per = shape.columns * shape.rows;
    const pages = [];
    for (let i = 0; i < cells.length; i += per) pages.push(`<div class="sheet">${cells.slice(i, i + per).join("")}</div>`);
    printDocument({
      title,
      styles: `@page{size:A4;margin:0} body{margin:0} .sheet{width:210mm;height:296mm;box-sizing:border-box;padding:${shape.top}mm 0 0 ${shape.left}mm;display:grid;
        grid-template-columns:repeat(${shape.columns},${shape.width}mm);grid-auto-rows:${shape.height}mm;page-break-after:always;overflow:hidden} ${label}`,
      body: pages.join(""),
    });
    return;
  }
  printDocument({
    title,
    styles: `@page{size:${shape.width}mm ${shape.height}mm;margin:0} body{margin:0} .page{width:${shape.width}mm;height:${shape.height}mm;page-break-after:always;overflow:hidden} ${label}`,
    body: cells.map((cell) => `<div class="page">${cell}</div>`).join(""),
  });
}

const VOUCHER_STYLES = "@page{size:A5 landscape;margin:8mm} body{font:10.5px system-ui;color:#111} h1{font-size:15px;margin:0} h2{font-size:13px;margin:10px 0 4px} small{color:#555}"
  + " .head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start} dl{display:grid;grid-template-columns:110px 1fr;gap:2px 10px;margin:6px 0} dt{color:#555}"
  + " table{width:100%;border-collapse:collapse;margin-top:6px} th,td{border-bottom:1px solid #ccc;padding:3px 4px;text-align:left;vertical-align:top} th{font-size:9.5px;color:#444}"
  + " .r{text-align:right;white-space:nowrap} tfoot td{font-weight:700;border-bottom:0} .declare{border:1px solid #999;padding:6px 8px;margin-top:8px}"
  + " .sign{display:flex;justify-content:space-between;gap:24px;margin-top:26px} .sign span{flex:1;border-top:1px solid #000;padding-top:3px;font-size:10px}";

// An old gold voucher: the shop, the seller with the photo ID seen and the
// PAN (or the Form 97 declaration), each article as tested and valued, the
// value and what became of it, and the seller's declaration to sign.
const wordsOf = (list) => Object.fromEntries(list.map((x) => [x.value, x.label]));
export function printOldGoldVoucher(biz, g) {
  const idKinds = wordsOf(ID_KINDS), testMethods = wordsOf(TEST_METHODS);
  const s = biz.settings || {};
  const w = (value) => Number(value || 0).toFixed(3);
  const rows = g.lines.map((l) => `<tr><td>${escapeHtml(l.description)}${Number(l.pieces) > 1 ? ` (${escapeHtml(l.pieces)})` : ""}${l.huid ? `<br><small>HUID ${escapeHtml(l.huid)}</small>` : ""}</td>
    <td>${escapeHtml(purityMark(l.metal, l.purity))}</td><td>${escapeHtml(testMethods[l.test_method] || l.test_method)} · ${escapeHtml(Number(l.tested_fineness).toFixed(1))}</td>
    <td class="r">${w(l.gross_weight)}</td><td class="r">${w(l.less_weight)}</td><td class="r">${w(l.net_weight)}</td><td class="r">${w(l.fine_weight)}</td>
    <td class="r">${escapeHtml(biz.exact(l.buy_rate))}</td><td class="r">${escapeHtml(Number(l.deduction_percent).toFixed(2))}%</td><td class="r">${escapeHtml(biz.exact(l.value))}</td></tr>`).join("");
  const settled = [...g.uses.map((u) => `${Number(u.amount) > 0 ? "Used on bill" : "Put back from bill"} ${escapeHtml(u.document_no)}: ${escapeHtml(biz.exact(Math.abs(Number(u.amount))))}`),
    ...g.payouts.map((p) => `Paid by ${escapeHtml(p.method_words)}${p.reference ? ` (${escapeHtml(p.reference)})` : ""}: ${escapeHtml(biz.exact(p.amount))}`)];
  printDocument({
    title: g.voucher_no,
    styles: VOUCHER_STYLES,
    body: `<div class="head"><div><h1>${escapeHtml(s.legal_name || s.display_name || biz.business.name)}</h1>
      <small>${escapeHtml([s.address_line1, s.address_line2, s.city, s.postal_code].filter(Boolean).join(", "))}${s.phone ? ` · ${escapeHtml(s.phone)}` : ""}${s.gstin ? ` · GSTIN ${escapeHtml(s.gstin)}` : ""}</small></div>
      <div><h1>Old gold voucher ${escapeHtml(g.voucher_no)}</h1><small>${escapeHtml(dateShort(g.created_at, { year: true }))} · buy rates of ${escapeHtml(dateShort(g.rate_date, { year: true }))}${g.state === "cancelled" ? " · CANCELLED" : ""}</small></div></div>
      <dl><dt>Seller</dt><dd><strong>${escapeHtml(g.seller_name)}</strong>${g.seller_phone ? ` · ${escapeHtml(g.seller_phone)}` : ""}</dd>
      <dt>Photo ID seen</dt><dd>${escapeHtml(idKinds[g.id_kind] || g.id_kind)} ${g.id_kind === "aadhaar" ? "ending " : ""}${escapeHtml(g.id_ref)}</dd>
      ${g.pan ? `<dt>PAN</dt><dd>${escapeHtml(g.pan)}</dd>` : g.pan_declaration ? "<dt>PAN</dt><dd>None: declaration signed (Form 97)</dd>" : ""}</dl>
      <table><thead><tr><th>Article</th><th>Valued as</th><th>Tested · fineness</th><th class="r">Gross g</th><th class="r">Less g</th><th class="r">Net g</th><th class="r">Fine g</th>
        <th class="r">Rate /g</th><th class="r">Deduction</th><th class="r">Value</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="5">Total${Number(g.round_off) ? ` (round-off ${escapeHtml(biz.exact(g.round_off))})` : ""}</td><td class="r">${w(g.net_weight)}</td><td class="r">${w(g.fine_weight)}</td><td></td><td></td>
        <td class="r">${escapeHtml(biz.exact(g.value))}</td></tr></tfoot></table>
      ${settled.length ? `<h2>Settled</h2><div>${settled.join("<br>")}</div>` : ""}
      ${g.notes ? `<p><small>${escapeHtml(g.notes)}</small></p>` : ""}
      <div class="declare">${escapeHtml(g.declaration)}</div>
      <div class="sign"><span>Seller: ${escapeHtml(g.seller_name)}</span><span>For ${escapeHtml(s.display_name || biz.business.name)}</span></div>`,
  });
}

// A gold scheme's passbook: the member, the plan's terms as they joined, the
// nominee, each instalment due and paid with its receipt, and the days that
// count, for the member to keep and sign.
export function printSchemePassbook(biz, s) {
  const shop = biz.settings || {};
  const day = (value) => (value ? escapeHtml(dateShort(value, { year: true })) : "");
  const rows = s.schedule.map((i) => `<tr><td>${i.seq}</td><td>${day(i.due_on)}</td><td>${i.paid ? day(i.paid.paid_on) : ""}</td>
    <td>${i.paid ? escapeHtml(i.paid.collection_no) : ""}</td><td class="r">${i.paid ? escapeHtml(biz.exact(i.paid.amount)) : escapeHtml(biz.exact(s.instalment))}</td>
    <td>${i.paid ? "" : "____________"}</td></tr>`).join("");
  printDocument({
    title: s.scheme_no,
    styles: VOUCHER_STYLES,
    body: `<div class="head"><div><h1>${escapeHtml(shop.legal_name || shop.display_name || biz.business.name)}</h1>
      <small>${escapeHtml([shop.address_line1, shop.address_line2, shop.city, shop.postal_code].filter(Boolean).join(", "))}${shop.phone ? ` · ${escapeHtml(shop.phone)}` : ""}</small></div>
      <div><h1>Gold scheme ${escapeHtml(s.scheme_no)}</h1><small>${escapeHtml(s.plan_name)} · joined ${day(s.started_on)}${s.status === "stopped" ? " · STOPPED" : s.status === "redeemed" ? " · REDEEMED" : ""}</small></div></div>
      <dl><dt>Member</dt><dd><strong>${escapeHtml(s.member_name)}</strong>${s.member_phone ? ` · ${escapeHtml(s.member_phone)}` : ""}</dd>
      ${s.nominee_name ? `<dt>Nominee</dt><dd>${escapeHtml(s.nominee_name)}${s.nominee_relation ? ` (${escapeHtml(s.nominee_relation)})` : ""}</dd>` : ""}
      <dt>Each month</dt><dd>${escapeHtml(biz.exact(s.instalment))} for ${escapeHtml(s.instalments)} months</dd>
      <dt>Discount</dt><dd>${escapeHtml(biz.exact(s.discount_when_complete))} off the jewellery bill, with every instalment paid, from ${day(s.maturity_on)}</dd>
      <dt>Close by</dt><dd>${day(s.close_by)}: the scheme is turned into jewellery by then</dd></dl>
      <table><thead><tr><th>No.</th><th>Due</th><th>Paid on</th><th>Receipt</th><th class="r">Amount</th><th>Signed</th></tr></thead><tbody>${rows}</tbody></table>
      <h2>Terms</h2><div class="declare">${escapeHtml(s.terms)}</div>
      <div class="sign"><span>Member: ${escapeHtml(s.member_name)}</span><span>For ${escapeHtml(shop.display_name || biz.business.name)}</span></div>`,
  });
}
