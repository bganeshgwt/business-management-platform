import { dateShort } from "@bmp/shared/format";

// What an offline bill's flags say (Daily money › Offline bills), by kind:
// a title and a tone, and the detail in a line or two (the server's
// business_till_flags.details).
export const FLAG_WORDS = {
  price: { title: "Price not the one in force", tone: "warning" },
  rate: { title: "GST rate not the one in force", tone: "warning" },
  credit: { title: "Over the customer's limit", tone: "warning" },
  stock: { title: "Stock short", tone: "danger" },
  time: { title: "Made outside the allowed time", tone: "warning" },
  no_pin: { title: "Made offline, no PIN", tone: "info" },
  discount: { title: "Discount over today's limit", tone: "warning" },
  cash_limit: { title: "Cash from one customer over ₹2,00,000 in a day", tone: "danger" },
  einvoice: { title: "To report to the IRP (e-invoice)", tone: "danger" },
  maker: { title: "Made by someone no longer billing here", tone: "warning" },
  total: { title: "The receipt differs by a paisa or two", tone: "info" },
};

// What a flag says, in a line or two.
export function flagDetail(flag, biz) {
  const d = flag.details || {};
  const lines = (d.lines || []);
  switch (flag.kind) {
    case "price": return lines.map((l) => (l.aboveMrp ? `${l.label}: above today's MRP of ${biz.exact(l.aboveMrp)}` : `${l.label}: billed ${biz.exact(l.billed)}, in force ${biz.exact(l.inForce)}${l.per ? ` a ${l.per}` : ""}`)).join(" · ");
    case "rate": return lines.map((l) => `${l.label}: GST ${Number(l.billed)}% charged, ${l.inForce}% in force on ${dateShort(d.day, { year: true })}`).join(" · ");
    case "credit": return d.walkIn ? `A walk-in left ${biz.exact(d.unpaid)} unpaid` : `Now owes ${biz.exact(d.owes)}, over the limit of ${biz.exact(d.limit)}`;
    case "stock": return lines.map((l) => `${l.label}: ${Number(l.quantity)} ${l.unit || ""} more than the books held`).join(" · ");
    case "time": return d.words || "";
    case "no_pin": return "The business asks the biller's PIN for every bill: it could not be checked offline.";
    case "discount": return `${biz.exact(d.amount)} off${d.reason ? ` (${d.reason})` : ""}; today's limit ${biz.exact(d.limit)}${d.allowed === false ? "; the maker may not give discounts now" : ""}`;
    case "cash_limit": return `Cash from this customer on ${dateShort(d.day, { year: true })}: ${biz.exact(d.cash)} (Income-tax Act 2025, section 186). Ask your accountant.`;
    case "einvoice": return `The buyer's GSTIN ${d.gstin}: report this invoice to the IRP within the time allowed.`;
    case "maker": return `${d.name} no longer bills at this business.`;
    case "total": return `Receipt ${biz.exact(d.receipt)}, posted ${biz.exact(d.posted)}`;
    default: return "";
  }
}

