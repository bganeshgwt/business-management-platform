import { escapeHtml, printDocument } from "../../../../services/print";
import { businessRead } from "../../../../services/business.service";
import { dateShort } from "@bmp/shared/format";
import { barcodeSvg } from "../../retail/services/barcode";
import { printTaxInvoice } from "../../core/pages/invoice";

// Printed papers of the fashion and electronics screens (pro pass E):
// the new bill of an exchange, the credit voucher, small helpers.

const svgOf = (code) => {
  try { return barcodeSvg(code).svg; } catch { return ""; }
};

// The bill posted by an exchange, on A4 or the 80 mm till roll.
export async function printBill(biz, documentId, paper = "80mm") {
  const doc = await businessRead(biz.id, `documents/${documentId}`);
  printTaxInvoice(doc, biz, { paper });
}

// A credit voucher (CV000123): the amount, valid until, the barcode to scan at the counter.
export function printVoucher(voucher, biz) {
  const seller = voucher.seller || {};
  const shop = seller.display_name || seller.legal_name || biz.business.name;
  printDocument({
    title: voucher.voucher_no,
    styles: `@page{size:80mm auto;margin:4mm} body{font:12px system-ui;color:#000;width:72mm}
      h1{font-size:15px;margin:0 0 2px;text-align:center} .c{text-align:center} .big{font:800 22px system-ui;text-align:center;margin:8px 0}
      .no{font:700 14px ui-monospace,Consolas,monospace;text-align:center;letter-spacing:1px} .bc{height:46px;margin:6px 0} .bc svg{width:100%;height:100%}
      dl{display:grid;grid-template-columns:auto 1fr;gap:3px 8px;margin:8px 0} dt{color:#444} small{color:#444} hr{border:0;border-top:1px dashed #000;margin:8px 0}`,
    body: `<h1>${escapeHtml(shop)}</h1>
      <div class="c"><small>${escapeHtml([seller.address_line1, seller.city].filter(Boolean).join(", "))}${seller.phone ? ` · ${escapeHtml(seller.phone)}` : ""}</small></div>
      <hr><div class="c"><strong>CREDIT VOUCHER</strong></div>
      <div class="big">${escapeHtml(biz.exact(Number(voucher.amount) - Number(voucher.used || 0)))}</div>
      <div class="bc">${svgOf(voucher.voucher_no)}</div><div class="no">${escapeHtml(voucher.voucher_no)}</div>
      <dl><dt>Valid until</dt><dd>${escapeHtml(dateShort(voucher.expires_on, { year: true }))}</dd>
      ${voucher.customer_name || voucher.contact_name ? `<dt>For</dt><dd>${escapeHtml(voucher.customer_name || voucher.contact_name)}${voucher.customer_phone ? ` · ${escapeHtml(voucher.customer_phone)}` : ""}</dd>` : ""}
      <dt>From bill</dt><dd>${escapeHtml(voucher.source_no || "")}</dd>
      <dt>Issued</dt><dd>${escapeHtml(dateShort(voucher.created_at, { year: true }))}</dd></dl>
      <hr><small>Use against any purchase in this shop before the date above. Not exchangeable for cash. Part-used vouchers keep their balance.</small>`,
  });
}

export async function printVoucherById(biz, voucherId) {
  printVoucher(await businessRead(biz.id, `vouchers/${voucherId}`), biz);
}
