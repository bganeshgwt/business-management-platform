import { escapeHtml, printDocument } from "../../../../services/print";
import { uploadUrl } from "../../../../services/api";

// The printed menu card (sweep SW-B-20): one outlet, one service, at the
// prices that outlet and service charge (the server works them out with the
// till's own selling rules). A4, two columns. A category heading never sits
// alone at the foot of a column or page — it keeps with its first dish — and
// no dish is split across a break. Veg, non-veg and egg carry the square
// marks Indian guests read at a glance; MRP items show their MRP.

const FOOD_MARKS = {
  veg: { cls: "veg", label: "Veg" },
  non_veg: { cls: "nonveg", label: "Non-veg" },
  egg: { cls: "egg", label: "Egg" },
};

const PRICE = (value, currency) => {
  const amount = Number(value || 0);
  const whole = Math.round(amount * 100) % 100 === 0;

  return `${currency}${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount)}`;
};

const STYLES = `
  body { font-family: Georgia, "Times New Roman", serif; color: #1b1b1b; font-size: 12.5px; }
  .head { text-align: center; border-bottom: 2px solid #1b1b1b; padding-bottom: 10px; margin-bottom: 14px; }
  .logo { max-height: 64px; max-width: 220px; margin: 0 auto 6px; display: block; }
  h1 { font-size: 26px; margin: 0; letter-spacing: .06em; text-transform: uppercase; }
  .service { font-family: system-ui, sans-serif; font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: #555; margin-top: 4px; }
  .addr { font-family: system-ui, sans-serif; font-size: 10.5px; color: #555; margin-top: 4px; }
  .cols { column-count: 2; column-gap: 30px; column-rule: 1px solid #ddd; }
  .cat { margin: 0 0 14px; }
  .cat h2 { font-size: 15px; margin: 0 0 2px; padding-bottom: 3px; border-bottom: 1px solid #1b1b1b;
            letter-spacing: .08em; text-transform: uppercase; break-after: avoid; page-break-after: avoid; }
  .cat .catnote { font-style: italic; color: #555; font-size: 11px; margin: 2px 0 6px; break-after: avoid; page-break-after: avoid; }
  .item { break-inside: avoid; page-break-inside: avoid; padding: 6px 0 5px; border-bottom: 1px dotted #ccc; }
  .line { display: flex; align-items: baseline; gap: 8px; }
  .name { font-weight: 700; flex: 1; min-width: 0; }
  .price { font-family: system-ui, sans-serif; font-weight: 700; white-space: nowrap; }
  .desc { color: #444; font-size: 11px; margin: 2px 0 0 18px; }
  .sizes, .addons { font-family: system-ui, sans-serif; font-size: 10.5px; color: #333; margin: 3px 0 0 18px; }
  .addons { color: #555; }
  .mark { display: inline-block; width: 10px; height: 10px; border: 1.5px solid; position: relative; flex: none;
          top: 1px; }
  .mark::after { content: ""; position: absolute; left: 2px; top: 2px; width: 3px; height: 3px; border-radius: 50%; background: currentColor; }
  .mark.veg { color: #1b7f3b; }
  .mark.nonveg { color: #8b2d1a; }
  .mark.egg { color: #c79100; }
  .mark.none { visibility: hidden; }
  .code { font-family: system-ui, sans-serif; font-weight: 400; color: #777; font-size: 10px; margin-left: 4px; }
  .foot { margin-top: 14px; border-top: 1px solid #1b1b1b; padding-top: 6px; font-family: system-ui, sans-serif;
          font-size: 10.5px; color: #333; display: flex; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
  .legend { display: inline-flex; gap: 12px; align-items: center; }
  .legend span { display: inline-flex; gap: 4px; align-items: center; }`;

const itemHtml = (item, card, options) => {
  const currency = card.restaurant.currency;
  const mark = FOOD_MARKS[item.foodType];
  const star = card.markInclusive && item.priceIncludesTax ? "*" : "";
  const price =
    item.mrp !== null && item.mrp !== undefined
      ? `MRP ${PRICE(item.mrp, currency)}`
      : item.sizes.length > 0
        ? ""
        : `${PRICE(item.price, currency)}${star}`;
  const sizes =
    item.sizes.length > 0
      ? `<div class="sizes">${item.sizes
          .map((size) => `${escapeHtml(size.name)} ${PRICE(size.price, currency)}${star}`)
          .join(" &nbsp;·&nbsp; ")}</div>`
      : "";
  const addOns =
    options.addOns && item.addOns.length > 0
      ? `<div class="addons">Add: ${item.addOns
          .map((addOn) => `${escapeHtml(addOn.name)} ${PRICE(addOn.price, currency)}`)
          .join(", ")}</div>`
      : "";
  const description = options.descriptions && item.description ? `<div class="desc">${escapeHtml(item.description)}</div>` : "";

  return `<div class="item">
    <div class="line">
      <span class="mark ${mark ? mark.cls : "none"}" title="${mark ? mark.label : ""}"></span>
      <span class="name">${escapeHtml(item.name)}${options.codes && item.code ? `<span class="code">${escapeHtml(item.code)}</span>` : ""}</span>
      <span class="price">${price}</span>
    </div>${description}${sizes}${addOns}
  </div>`;
};

export const printMenuCard = (card, options = {}) => {
  const logo = options.logo !== false && card.restaurant.logo ? uploadUrl(card.restaurant.logo) : null;
  const where = card.outlet ? `${card.outlet.name} · ${card.orderTypeLabel}` : card.orderTypeLabel;
  const contact = [card.restaurant.address, card.restaurant.contact].filter(Boolean).map(escapeHtml).join(" · ");
  const legal = [
    card.restaurant.fssai ? `FSSAI Lic. No. ${escapeHtml(card.restaurant.fssai)}` : null,
    card.restaurant.gstin ? `GSTIN ${escapeHtml(card.restaurant.gstin)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const body = `
    <div class="head">
      ${logo ? `<img class="logo" src="${escapeHtml(logo)}" alt="" />` : ""}
      <h1>${escapeHtml(card.restaurant.name)}</h1>
      <div class="service">${escapeHtml(where)} menu</div>
      ${contact ? `<div class="addr">${contact}</div>` : ""}
    </div>
    <div class="cols">
      ${card.categories
        .map(
          (category) => `<section class="cat">
            <h2>${escapeHtml(category.name)}</h2>
            ${category.note ? `<div class="catnote">${escapeHtml(category.note)}</div>` : ""}
            ${category.items.map((item) => itemHtml(item, card, options)).join("")}
          </section>`
        )
        .join("")}
    </div>
    <div class="foot">
      <span>${escapeHtml(card.taxNote)}</span>
      <span class="legend">
        <span><i class="mark veg"></i> Veg</span>
        <span><i class="mark nonveg"></i> Non-veg</span>
        <span><i class="mark egg"></i> Egg</span>
      </span>
      ${legal ? `<span>${legal}</span>` : ""}
    </div>`;

  printDocument({
    title: `Menu — ${card.restaurant.name}${card.outlet ? ` — ${card.outlet.name}` : ""} — ${card.orderTypeLabel}`,
    styles: STYLES,
    body,
  });
};
