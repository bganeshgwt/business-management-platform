// Table QR codes: the address each one opens, and printed sheets of them.
// Plain functions with explicit extensions, so a test can run them outside
// the bundler and read back the codes it draws.
import QRCode from "qrcode";
import { escapeHtml as escape } from "./print.js";

// How the codes go on paper. A4 cards are cut out and stood in holders; a
// table tent is one A4 folded in half, the card on both faces so it reads
// from either side of the table.
export const QR_LAYOUTS = [
  { key: "a4-4", label: "A4 · 4 cards", hint: "Large cards for stands", perPage: 4, columns: 2, rows: 2 },
  { key: "a4-6", label: "A4 · 6 cards", hint: "The usual size", perPage: 6, columns: 2, rows: 3 },
  { key: "a4-9", label: "A4 · 9 cards", hint: "Stickers for small tables", perPage: 9, columns: 3, rows: 3 },
  { key: "tent", label: "Table tent", hint: "One table per page, folded", perPage: 1, columns: 1, rows: 1 },
];

export const layoutOf = (key) => QR_LAYOUTS.find((layout) => layout.key === key) || QR_LAYOUTS[1];

// Addresses a guest's phone on mobile data cannot open: this computer, and
// the private ranges a shop-floor network hands out.
export const isLocalHost = (hostname) => {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");

  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host)
  );
};

const hostOf = (address) => {
  try {
    return new URL(address).hostname;
  } catch {
    return "";
  }
};

// The address QR codes are built from: the one the restaurant set, or else
// the address this screen is on.
export const guestBase = (configured, origin) => String(configured || origin || "").replace(/\/+$/, "");

export const guestOrderUrl = (base, token) => `${guestBase(base)}/order/${token}`;

// What the QR screens should warn about, if anything:
//   "local"       nothing set and this screen is on a local address — the
//                 codes would open nowhere on a guest's phone
//   "local-set"   the address set is itself a local one: only phones on the
//                 restaurant's own Wi-Fi can open it
//   null          fine
export const addressProblem = (configured, origin) => {
  if (configured) {
    return isLocalHost(hostOf(configured)) ? "local-set" : null;
  }

  return isLocalHost(hostOf(origin)) ? "local" : null;
};

export const ADDRESS_WARNINGS = {
  local:
    "These QR codes would open this computer's own address, which guests' phones cannot reach. Set the guest ordering web address before printing.",
  "local-set":
    "The guest ordering web address is a local one: only phones on the restaurant's own Wi-Fi can open these codes.",
};

// Tables a sheet covers: all, one floor or one area, in table-number order
// ("T2" before "T10"), leaving out tables that are out of service unless
// asked to keep them.
export const tablesForSheet = (tables, { scope = "all", floorId = "", areaId = "", includeOff = false } = {}) =>
  (tables || [])
    .filter((table) => (scope === "floor" ? String(table.floorId) === String(floorId) : true))
    .filter((table) => (scope === "area" ? String(table.areaId) === String(areaId) : true))
    .filter((table) => includeOff || (table.status === "active" && table.floorState !== "out_of_service"))
    .sort(
      (a, b) =>
        String(a.floorName || "").localeCompare(String(b.floorName || ""), "en-IN") ||
        String(a.tableNo).localeCompare(String(b.tableNo), "en-IN", { numeric: true })
    );

const card = ({ table, image, url, restaurantName, logoUrl, layout }) => `
  <div class="card ${layout.key}">
    ${logoUrl ? `<img class="logo" src="${escape(logoUrl)}" alt="" />` : ""}
    <p class="brand">${escape(restaurantName || "")}</p>
    <p class="table">Table ${escape(table.tableNo)}</p>
    <img class="code" src="${escape(image)}" alt="QR code for table ${escape(table.tableNo)}" />
    <p class="call">Scan to order</p>
    <p class="hint">Point your phone's camera at the code</p>
    <p class="url">${escape(url)}</p>
  </div>`;

// The printable sheets: { title, styles, body, pages, cards }. Every code is
// drawn here from the table's own token, so a sheet printed today keeps
// working until that one table's code is made again.
export const buildQrSheet = async ({ tables, layoutKey, base, restaurantName = "", logoUrl = "" }) => {
  const layout = layoutOf(layoutKey);
  const drawn = await Promise.all(
    tables.map(async (table) => {
      const url = guestOrderUrl(base, table.qrToken);
      const image = await QRCode.toDataURL(url, { width: 480, margin: 1, errorCorrectionLevel: "M" });

      return { table, url, image };
    })
  );

  const pages = [];

  for (let at = 0; at < drawn.length; at += layout.perPage) {
    pages.push(drawn.slice(at, at + layout.perPage));
  }

  const body = pages
    .map((page) =>
      layout.key === "tent"
        ? `<section class="sheet tent">
             <div class="half flip">${card({ ...page[0], restaurantName, logoUrl, layout })}</div>
             <div class="fold">Fold here</div>
             <div class="half">${card({ ...page[0], restaurantName, logoUrl, layout })}</div>
           </section>`
        : `<section class="sheet grid">${page
            .map((item) => card({ ...item, restaurantName, logoUrl, layout }))
            .join("")}</section>`
    )
    .join("");

  // Card sizes follow the page: the codes stay at least 3.5 cm wide even
  // nine to a page, which any phone camera reads from arm's length.
  const codeSize = { "a4-4": "78mm", "a4-6": "56mm", "a4-9": "40mm", tent: "70mm" }[layout.key];
  const tableSize = { "a4-4": "30px", "a4-6": "24px", "a4-9": "18px", tent: "34px" }[layout.key];

  const styles = `
    @page { size: A4; margin: 8mm; }
    body { font-family: system-ui, "Segoe UI", sans-serif; color: #111; margin: 0; }
    p { margin: 0; }
    .sheet { box-sizing: border-box; width: 194mm; height: 281mm; page-break-after: always; break-after: page; }
    .sheet:last-child { page-break-after: auto; break-after: auto; }
    .grid { display: grid; grid-template-columns: repeat(${layout.columns}, 1fr); grid-template-rows: repeat(${layout.rows}, 1fr); gap: 4mm; }
    .card { box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 1.5mm; padding: 4mm; border: 1px dashed #999; border-radius: 4mm; text-align: center; overflow: hidden; }
    .logo { max-height: 14mm; max-width: 40mm; object-fit: contain; }
    .brand { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: #333; }
    .table { font-size: ${tableSize}; font-weight: 800; }
    .code { width: ${codeSize}; height: ${codeSize}; }
    .call { font-size: 16px; font-weight: 800; }
    .hint { font-size: 10px; color: #555; }
    .url { font-size: 8px; color: #777; word-break: break-all; }
    .tent { display: flex; flex-direction: column; }
    .half { flex: 1; display: flex; }
    .half .card { flex: 1; border: 0; }
    .flip { transform: rotate(180deg); }
    .fold { border-top: 1px dashed #999; font-size: 9px; color: #999; text-align: center; padding-top: 1mm; height: 4mm; }
  `;

  return {
    title: `Table QR codes (${drawn.length})`,
    styles,
    body,
    pages: pages.length,
    cards: drawn.map(({ table, url, image }) => ({ tableId: table.id, tableNo: table.tableNo, url, image })),
  };
};
