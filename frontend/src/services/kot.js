// What the kitchen display needs besides the API: how long a ticket has been
// waiting and what colour that is, where the food is going, the all-day count,
// the printed KOT and the new-ticket chime.
//
// Plain functions with explicit extensions, so they can be exercised outside
// the bundler, like receipt.js.
import { escapeHtml as escape, printDocument } from "./print.js";

export const COLUMNS = [
  { key: "new", label: "New", hint: "Not started" },
  { key: "cooking", label: "Cooking", hint: "On the stove" },
  { key: "ready", label: "Ready", hint: "At the pass" },
];

// The swatches a station can take. The CSS has a light and a dark shade of
// each, so a colour picked here reads on any screen.
export const STATION_COLORS = [
  "orange",
  "red",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
  "slate",
];

// 754 seconds -> "12:34"; past 99 minutes a clock stops being readable at a
// glance, so it becomes "1h 42m".
export const clock = (milliseconds) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);

  // A day or more is a ticket nobody closed: "3 days", not "73h 10m".
  if (minutes >= 24 * 60) {
    const days = Math.floor(minutes / (24 * 60));
    return days === 1 ? "1 day" : `${days} days`;
  }

  if (minutes > 99) {
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

// An average or a total for the figures strip: "11m 40s", "1h 05m". A
// negative figure can only come from tickets stamped wrongly (marked ready
// before they were sent); it is shown as unknown, never as a perfect
// "0m 00s" kitchen.
export const duration = (seconds) => {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) {
    return "—";
  }

  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);

  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  }

  return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
};

// Calm, warning or late, from how long something has been waiting against
// the restaurant's own marks.
export const toneFor = (milliseconds, warnMinutes, lateMinutes) => {
  const minutes = milliseconds / 60000;

  if (minutes >= lateMinutes) {
    return "late";
  }

  return minutes >= warnMinutes ? "warning" : "calm";
};

// The clock a ticket shows, and what it is measuring. A ticket in the kitchen
// counts from when the waiter sent it; a ticket at the pass counts how long
// the food has been sitting there, because that is the problem now.
export const ticketClock = (ticket, now, settings) => {
  if (ticket.status === "ready" && ticket.readyAt) {
    const waiting = now - new Date(ticket.readyAt).getTime();
    const pass = settings.passMinutes || 8;

    return {
      text: clock(waiting),
      tone: toneFor(waiting, pass / 2, pass),
      label: "at the pass",
    };
  }

  const waiting = now - new Date(ticket.createdAt).getTime();

  return {
    text: clock(waiting),
    tone: toneFor(waiting, settings.warnMinutes, settings.lateMinutes),
    label: ticket.status === "new" ? "waiting" : "cooking",
  };
};

// The app's own short month names. The browser's "en-IN" short month for
// September is "Sept", which reads oddly on a ticket and matches nothing else
// the app prints.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "23 Sep": the day a ticket was sent, on this device's clock.
export const kotDate = (value) => {
  const at = new Date(value);

  return Number.isNaN(at.getTime()) ? "" : `${at.getDate()} ${MONTHS[at.getMonth()]}`;
};

// "7:42 pm", the way a kitchen reads a time.
export const timeOfDay = (value) =>
  new Date(value)
    .toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s?([ap])\.?m\.?/i, (match, letter) => ` ${letter.toLowerCase()}m`);

// Where the plate goes, big, and what else the cook should know, small.
export const destination = (ticket) => {
  const table = ticket.tableNo
    ? /^\d+$/.test(String(ticket.tableNo))
      ? `Table ${ticket.tableNo}`
      : String(ticket.tableNo)
    : null;

  if ((ticket.orderType === "dine_in" || ticket.orderType === "qr") && table) {
    return { primary: table, secondary: ticket.orderType === "qr" ? "QR order" : "Dine-in" };
  }

  const kinds = {
    takeaway: "Takeaway",
    delivery: ticket.source === "partner" ? "Partner delivery" : "Delivery",
    online: "Online order",
  };

  return {
    primary: kinds[ticket.orderType] || "Counter",
    secondary: ticket.customerName || null,
  };
};

export const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// ---------------------------------------------------------------- kitchen names
//
// SW-A-12: a dish, size or add-on may carry a kitchen name in the cooks' own
// script (पनीर टिक्का, பனீர் டிக்கா). The kitchen settings choose what tickets,
// the kitchen screen and change slips show; each ticket and slip carries that
// choice (nameMode) from the API, so a till printing a KOT follows it too.
// Where no kitchen name is set, the menu name shows whatever the choice.

export const NAME_MODES = [
  { value: "both", label: "Both", hint: "Kitchen name large, menu name small under it" },
  { value: "kitchen", label: "Kitchen name", hint: "Only the kitchen name; the menu name where none is set" },
  { value: "menu", label: "Menu name", hint: "The name on the menu and the bill, as before" },
];

// { main, sub }: what a dish line shows large, and the menu name in small
// type under it ("both" only).
export const dishNames = (menuName, kitchenName, mode = "both") => {
  if (!kitchenName || mode === "menu" || kitchenName === menuName) {
    return { main: menuName, sub: null };
  }

  return mode === "kitchen" ? { main: kitchenName, sub: null } : { main: kitchenName, sub: menuName };
};

// The one-line form for a size, an add-on or a combo part: "हाफ (Half)".
export const inlineName = (menuName, kitchenName, mode = "both") => {
  const { main, sub } = dishNames(menuName, kitchenName, mode);

  return sub ? `${main} (${sub})` : main;
};

// A ticket line's names, as the ticket's mode shows them.
export const itemNames = (item, mode = "both") => ({
  ...dishNames(item.name, item.kitchenName, mode),
  variant: item.variant ? inlineName(item.variant, item.variantKitchenName, mode) : null,
  modifiers: (item.modifiers || []).map((name, index) =>
    inlineName(name, (item.modifierKitchenNames || [])[index], mode)
  ),
  components: (item.components || []).map((part) => ({
    ...part,
    name: inlineName(part.name, part.kitchenName, mode),
    variant: part.variant ? inlineName(part.variant, part.variantKitchenName, mode) : null,
  })),
});

// A short name for a list ("2 × पनीर टिक्का"): the large one alone.
export const shortName = (line, mode = "both") => {
  const { main } = dishNames(line.name, line.kitchenName, mode);
  const size = line.variant ? inlineName(line.variant, line.variantKitchenName, mode === "both" ? "kitchen" : mode) : "";

  return size ? `${main} (${size})` : main;
};

// A quantity as a cook reads it: 2, or 1.5 for a portion and a half.
export const qty = (value) => (Number.isInteger(value) ? String(value) : String(Number(value)));

// The all-day count: how many of each dish are still to fire across every
// open ticket. A tandoor cook slaps fourteen naans in one go rather than
// reading fourteen tickets.
export const allDayCounts = (tickets) => {
  const counts = new Map();

  for (const ticket of tickets) {
    if (ticket.status !== "new" && ticket.status !== "cooking") {
      continue;
    }

    for (const item of ticket.items) {
      if (item.isDone || item.liveQuantity <= 0) {
        continue;
      }

      const key = `${item.name}|${item.variant || ""}`;
      const names = itemNames(item, ticket.nameMode);
      const entry = counts.get(key) || {
        key,
        name: item.name,
        // SW-A-12: the names as the kitchen reads them.
        label: names.main,
        subLabel: names.sub,
        variant: item.variant,
        variantLabel: names.variant,
        foodType: item.foodType,
        quantity: 0,
        tickets: 0,
      };

      entry.quantity += item.liveQuantity;
      entry.tickets += 1;
      counts.set(key, entry);
    }
  }

  return [...counts.values()].sort(
    (a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name)
  );
};

// ---------------------------------------------------------------- printing

const PAPER_WIDTHS = { "58mm": 220, "80mm": 300, a4: 420 };

export const paperPixels = (paperWidth) => PAPER_WIDTHS[paperWidth] || PAPER_WIDTHS["80mm"];

// The ticket's typeface, then every Indian script by name: a monospace font
// has no Devanagari or Tamil, and the browser takes each letter from the
// first font in this list that has it (Nirmala UI on Windows, Noto on
// Android and Linux, the older per-script Windows fonts after them), so a
// kitchen name never prints as empty boxes.
export const KOT_FONTS = [
  "ui-monospace",
  '"Cascadia Mono"',
  "Menlo",
  "Consolas",
  '"Nirmala UI"',
  '"Noto Sans Devanagari"',
  '"Noto Sans Tamil"',
  '"Noto Sans Telugu"',
  '"Noto Sans Kannada"',
  '"Noto Sans Malayalam"',
  '"Noto Sans Bengali"',
  '"Noto Sans Gujarati"',
  '"Noto Sans Gurmukhi"',
  '"Noto Sans Oriya"',
  "Mangal",
  "Latha",
  "Gautami",
  "Tunga",
  "Kartika",
  "Vrinda",
  "Shruti",
  "monospace",
].join(", ");

// A kitchen ticket is read from a rail at arm's length, with wet hands and a
// hot pan: station, number and table in big type, then one line per dish with
// the quantity first. Notes are boxed, because a missed "no onion" is a plate
// sent back.
export const buildKot = (ticket, { restaurantName = "" } = {}) => {
  const where = destination(ticket);
  const live = ticket.items.filter((item) => item.liveQuantity > 0);
  const voided = ticket.items.filter((item) => item.cancelledQuantity > 0);
  const mode = ticket.nameMode || "both";

  const lines = live
    .map((item) => {
      const names = itemNames(item, mode);
      const extras = [
        // "both": the menu name in small type under the kitchen name.
        names.sub ? `<div class="mn">${escape(names.sub)}</div>` : "",
        names.variant ? `<div class="sub">${escape(names.variant)}</div>` : "",
        ...names.modifiers.map((modifier) => `<div class="sub">+ ${escape(modifier)}</div>`),
        ...names.components.map(
          (part) =>
            `<div class="sub">&bull; ${escape(qty(part.quantity))} x ${escape(part.name)}${
              part.variant ? ` (${escape(part.variant)})` : ""
            }</div>`
        ),
        item.notes ? `<div class="note">${escape(item.notes)}</div>` : "",
      ].join("");

      return `<tr><td class="q">${escape(qty(item.liveQuantity))}</td><td class="d">${escape(
        names.main
      )}${extras}</td></tr>`;
    })
    .join("");

  const cancelled = voided.length
    ? `<p class="void">CANCELLED: ${voided
        .map((item) => `${escape(qty(item.cancelledQuantity))} x ${escape(shortName(item, mode))}`)
        .join(", ")}</p>`
    : "";

  // A reprint says so, so the same ticket cannot be cooked twice.
  const reprint =
    ticket.printCount > 1 ? `<p class="reprint">REPRINT (${escape(ticket.printCount)})</p>` : "";

  const covers = ticket.guestCount ? ` &middot; ${escape(ticket.guestCount)} covers` : "";
  const round = ticket.round > 1 ? ` &middot; Round ${escape(ticket.round)}` : "";
  const sent = new Date(ticket.createdAt);

  // Who took the order, so the pass knows whom to call when the food is up —
  // and, for a later round added or fired by someone else, who sent it.
  const taker = [ticket.takenByLabel, ticket.sentByLabel]
    .filter(Boolean)
    .map((label) => `<p class="taker">${escape(label)}</p>`)
    .join("");

  return `
    ${restaurantName ? `<p class="brand">${escape(restaurantName)}</p>` : ""}
    <p class="station">${escape(ticket.stationName)}</p>
    <p class="kot">${escape(ticket.kotNo)}</p>
    ${ticket.tokenNo ? `<p class="token">TOKEN ${escape(ticket.tokenNo)}</p>` : ""}
    <p class="where">${escape(where.primary)}${covers}</p>
    <p class="meta">${escape(where.secondary || "")}${where.secondary ? " &middot; " : ""}${escape(
      ticket.orderNumber
    )}${round}<br/>${escape(timeOfDay(sent))} &middot; ${escape(kotDate(sent))}</p>
    ${taker}
    ${reprint}
    <table>${lines}</table>
    ${cancelled}
    ${ticket.orderNotes ? `<div class="note order">ORDER NOTE: ${escape(ticket.orderNotes)}</div>` : ""}
    <p class="foot">${escape(plural(live.length, "dish", "dishes"))} &middot; ${escape(
      ticket.kotNo
    )}</p>
  `;
};

// The KOT's print styles, exported so the paper can be checked on a screen.
export const kotStyles = (paperWidth = "80mm") => `
      body {
        font-family: ${KOT_FONTS};
        font-size: 15px;
        width: ${paperPixels(paperWidth)}px;
        margin: 0 auto;
        color: #000;
      }
      p { margin: 0; }
      .brand { text-align: center; font-size: 11px; margin-bottom: 4px; }
      .station { text-align: center; font-size: 17px; font-weight: bold; text-transform: uppercase;
                 background: #000; color: #fff; padding: 3px 0; letter-spacing: 1px; }
      .kot { text-align: center; font-size: 30px; font-weight: bold; margin: 4px 0 0; }
      .token { text-align: center; font-size: 34px; font-weight: bold; border: 3px solid #000;
               margin: 4px 0; padding: 2px 0; letter-spacing: 2px; }
      .where { text-align: center; font-size: 24px; font-weight: bold; }
      .meta { text-align: center; font-size: 12px; margin: 2px 0 6px; }
      .taker { text-align: center; font-size: 14px; font-weight: bold; margin: -2px 0 6px; }
      .reprint { text-align: center; font-weight: bold; border: 2px solid #000; margin: 4px 0; }
      table { width: 100%; border-collapse: collapse; border-top: 2px dashed #000;
              border-bottom: 2px dashed #000; }
      td { padding: 5px 0; vertical-align: top; border-bottom: 1px dotted #000; }
      tr:last-child td { border-bottom: 0; }
      .q { width: 40px; font-size: 22px; font-weight: bold; }
      .d { font-size: 18px; font-weight: bold; line-height: 1.35; overflow-wrap: anywhere; }
      .mn { font-size: 12px; font-weight: normal; line-height: 1.2; }
      .sub { font-size: 13px; font-weight: normal; padding-left: 4px; line-height: 1.35; }
      .note { font-size: 14px; font-weight: bold; border: 2px solid #000; padding: 2px 4px;
              margin-top: 3px; text-transform: uppercase; }
      .note.order { margin-top: 8px; }
      .void { font-size: 12px; margin-top: 6px; text-decoration: line-through; }
      .foot { text-align: center; font-size: 11px; margin-top: 8px; }
    `;

export const printKot = (ticket, { restaurantName = "", paperWidth = "80mm" } = {}) => {
  if (!ticket || !Array.isArray(ticket.items)) {
    return;
  }

  printDocument({
    title: `${ticket.kotNo} ${ticket.stationName}`,
    styles: kotStyles(paperWidth),
    body: buildKot(ticket, { restaurantName }),
  });
};

// ---------------------------------------------------------------- change slips
//
// The paper that follows a paper KOT when the order behind it changes (the
// API's kitchen change slips): dishes taken off, the whole order cancelled,
// or the food now going to another table. Read at the pass like a KOT, so the
// word that matters — CANCEL or TABLE CHANGED — is the biggest thing on it.

const SLIP_TITLES = {
  cancel: "CANCEL",
  order_cancelled: "ORDER CANCELLED",
  table_changed: "TABLE CHANGED",
};

export const slipTitle = (slip) => SLIP_TITLES[slip.kind] || "CHANGE";

// "Table 5" or "T5": a bare number reads better with the word.
const tableText = (value) => (value ? (/^\d+$/.test(String(value)) ? `Table ${value}` : String(value)) : "");

// One line a person can read on a screen: "CANCEL · Tandoor · 1 x Butter Naan".
export const slipSummary = (slip) => {
  const dishes = (slip.lines || [])
    .map((line) => `${qty(line.quantity)} x ${shortName(line, slip.nameMode)}`)
    .join(", ");

  if (slip.kind === "table_changed") {
    return `${tableText(slip.fromTableNo)} → ${tableText(slip.toTableNo)} · ${slip.stationName} · ${dishes}`;
  }

  return `${slipTitle(slip)} · ${slip.stationName} · ${dishes}`;
};

export const buildSlip = (slip, { restaurantName = "" } = {}) => {
  const moved = slip.kind === "table_changed";
  const sign = moved ? "" : "&minus;";
  const mode = slip.nameMode || "both";
  const lines = (slip.lines || [])
    .map((line) => {
      // The same names the KOT printed, so the cook matches the two papers.
      const names = dishNames(line.name, line.kitchenName, mode);
      const size = line.variant ? inlineName(line.variant, line.variantKitchenName, mode) : "";

      return `<tr><td class="q">${sign}${escape(qty(line.quantity))}</td><td class="d">${escape(names.main)}${
        names.sub ? `<div class="mn">${escape(names.sub)}</div>` : ""
      }${size ? `<div class="sub">${escape(size)}</div>` : ""}<div class="sub">${escape(line.kotNo)}</div></td></tr>`;
    })
    .join("");
  const at = new Date(slip.createdAt);
  const where = moved
    ? `<p class="move">${escape(tableText(slip.fromTableNo))} &rarr; ${escape(tableText(slip.toTableNo))}</p>`
    : `<p class="where">${escape(
        tableText(slip.tableNo) || destination({ orderType: slip.orderType, tableNo: slip.tableNo }).primary
      )}</p>`;
  const who = [
    slip.changedByName ? `By ${escape(slip.changedByName)}` : "",
    slip.approvedByName ? `approved by ${escape(slip.approvedByName)}` : "",
  ]
    .filter(Boolean)
    .join(" &middot; ");
  // A second print says so, like a KOT: the same correction is never taken
  // for a second one.
  const reprint = slip.printCount > 1 ? `<p class="reprint">REPRINT (${escape(slip.printCount)})</p>` : "";
  const instruction = moved
    ? "Send these to the new table"
    : slip.kind === "order_cancelled"
      ? "Stop cooking this order"
      : "Stop cooking these";

  return `
    ${restaurantName ? `<p class="brand">${escape(restaurantName)}</p>` : ""}
    <p class="title">${escape(slipTitle(slip))}</p>
    <p class="station">${escape(slip.stationName)}</p>
    ${where}
    <p class="meta">${escape(slip.orderNumber)} &middot; ${escape((slip.kotNos || []).join(", "))}<br/>${escape(
      timeOfDay(at)
    )} &middot; ${escape(kotDate(at))}</p>
    ${reprint}
    <p class="instruction">${escape(instruction)}</p>
    <table>${lines}</table>
    ${slip.reason ? `<div class="note">REASON: ${escape(slip.reason)}</div>` : ""}
    ${who ? `<p class="who">${who}</p>` : ""}
  `;
};

export const slipStyles = (paperWidth = "80mm") => `
      body {
        font-family: ${KOT_FONTS};
        font-size: 15px;
        width: ${paperPixels(paperWidth)}px;
        margin: 0 auto;
        color: #000;
      }
      p { margin: 0; }
      .brand { text-align: center; font-size: 11px; margin-bottom: 4px; }
      .title { text-align: center; font-size: 26px; font-weight: bold; letter-spacing: 1px;
               border: 3px solid #000; padding: 4px 0; margin-bottom: 4px; }
      .station { text-align: center; font-size: 17px; font-weight: bold; text-transform: uppercase;
                 background: #000; color: #fff; padding: 3px 0; letter-spacing: 1px; }
      .where, .move { text-align: center; font-size: 26px; font-weight: bold; margin-top: 4px; }
      .meta { text-align: center; font-size: 12px; margin: 2px 0 6px; }
      .reprint { text-align: center; font-weight: bold; border: 2px solid #000; margin: 4px 0; }
      .instruction { text-align: center; font-size: 14px; font-weight: bold; margin: 4px 0;
                     text-transform: uppercase; }
      table { width: 100%; border-collapse: collapse; border-top: 2px dashed #000;
              border-bottom: 2px dashed #000; }
      td { padding: 5px 0; vertical-align: top; border-bottom: 1px dotted #000; }
      tr:last-child td { border-bottom: 0; }
      .q { width: 48px; font-size: 22px; font-weight: bold; }
      .d { font-size: 18px; font-weight: bold; line-height: 1.35; overflow-wrap: anywhere; }
      .mn { font-size: 12px; font-weight: normal; line-height: 1.2; }
      .sub { font-size: 12px; font-weight: normal; padding-left: 4px; line-height: 1.35; }
      .note { font-size: 14px; font-weight: bold; border: 2px solid #000; padding: 2px 4px; margin-top: 6px; }
      .who { text-align: center; font-size: 12px; margin-top: 6px; }
    `;

export const printSlip = (slip, { restaurantName = "", paperWidth = "80mm" } = {}) => {
  if (!slip || !Array.isArray(slip.lines)) {
    return;
  }

  printDocument({
    title: `${slipTitle(slip)} ${slip.orderNumber} ${slip.stationName}`,
    styles: slipStyles(paperWidth),
    body: buildSlip(slip, { restaurantName }),
  });
};

// ---------------------------------------------------------------- the chime
//
// A browser will not play sound until someone has touched the page, and it
// complains if an audio context is even created before then. So nothing is
// created until the first tap; after that, a new ticket can chime.

let context = null;

export const unlockChime = () => {
  const Context = window.AudioContext || window.webkitAudioContext;

  if (!Context) {
    return false;
  }

  if (!context) {
    context = new Context();
  }

  if (context.state === "suspended") {
    context.resume().catch(() => undefined);
  }

  return true;
};

export const chimeReady = () => Boolean(context && context.state === "running");

// Two short rising notes: noticeable over an extractor fan, not alarming.
export const playChime = () => {
  if (!context) {
    return;
  }

  const start = context.currentTime + 0.02;

  [
    [880, 0],
    [1320, 0.17],
  ].forEach(([frequency, offset]) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.3, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.18);
  });
};
