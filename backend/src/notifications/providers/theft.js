// Theft control: money or food that leaves the system after it went in — a
// bill voided, money refunded, a big discount, a bill printed again and again,
// a dish taken off an order after the kitchen had it, and a drawer closed
// short. Owners catch fiddles the same day only if they are told the same
// day, without going to read the activity log.
//
// For the people who read the activity log (audit.view): owners and managers.
// Never for the cashier or captain whose actions these are.
//
// Looks at the day being traded, and at the last day closed in the past
// eighteen hours — last night's voids should still be in the bell when the
// owner opens it the next morning. Every query reads by business day or by a
// time window on an indexed column, so the bell never scans history.
//
// A failed query is left to reject, so the registry reports this area as
// "could not check" instead of "all clear".
const { completeContext } = require("..");
const { VOIDED_BILL_OF_REMOVAL, DRAWER_EXPECTED } = require("../../modules/restaurant/reports/repositories/report.repository");

// A discount is "large" at a fifth of the bill, or ₹1,000 on any bill — the
// same line the theft-control report draws by default.
const LARGE_DISCOUNT_PERCENT = 20;
const LARGE_DISCOUNT_AMOUNT = 1000;
// Half the bill given away is a warning, not just worth knowing.
const HUGE_DISCOUNT_PERCENT = 50;
// One reprint is a guest asking for a copy. A third print is worth a look.
const REPRINT_ALERT_PRINTS = 3;
// A drawer a few rupees out is loose change; past this it is a question.
const CASH_SHORT_WARNING = 100;
const CASH_SHORT_CRITICAL = 1000;
// Last night's closed day stays in view until the next day is well under way.
const RECENT_CLOSE_HOURS = 18;
// Past this many of one kind, the rest are one summary line.
const NAMED_LIMIT = 5;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const timeLabel = (at, timezone) =>
  new Intl.DateTimeFormat("en-IN", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(at))
    .replace(/\s?([ap])\.?m\.?$/i, (_, half) => `${half.toLowerCase()}m`);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "Tue 22 Sep", built by hand: en-IN spells September "Sept".
const dateLabel = (isoDate) => {
  const [year, month, day] = String(isoDate).split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${day} ${MONTHS[month - 1]}`;
};

const reportLink = (date) => `/reports?tab=theft&from=${date}&to=${date}`;

const who = (name, approver) =>
  [name ? `by ${name}` : null, approver ? `approved by ${approver}` : null].filter(Boolean).join(" · ");

const REASONS = {
  guest_changed_mind: "guest changed their mind",
  wrong_order: "wrong order",
  delay: "took too long",
  quality: "quality complaint",
  other: "other",
};

// The worst few by name, the rest as one summary that stays read until a new
// one joins it (README: members).
const nameOrSummarise = (alerts, summary) => {
  if (alerts.length <= NAMED_LIMIT) {
    return alerts;
  }

  const sorted = [...alerts].sort((a, b) => b.weight - a.weight);
  const named = sorted.slice(0, NAMED_LIMIT);
  const rest = sorted.slice(NAMED_LIMIT);

  return [
    ...named,
    {
      ...summary(rest),
      members: rest.map((alert) => alert.id),
      at: rest.reduce((latest, alert) => (alert.at > latest ? alert.at : latest), rest[0].at),
    },
  ];
};

async function collectAlerts({ restaurantId, businessDate, timezone, now, pool, money }) {
  // The days in view: every day being traded — the main counter's and each
  // outlet's own (a branch trades a day of its own, and its refunds, voids
  // and drawer are in it) — and any closed in the last few hours. Bills
  // raised with no day open are read by their local date.
  const days = await pool.query(
    `SELECT bd.id, bd.business_date::text AS business_date, bd.day_status, bd.closed_at, bd.opening_cash,
            bd.closing_cash, bd.closed_by, bd.outlet_id, ol.name AS outlet_name
     FROM business_days bd
     LEFT JOIN outlets ol ON ol.id = bd.outlet_id
     WHERE bd.restaurant_id = $1
       AND (bd.business_date = $2::date
            OR bd.day_status = 'open'
            OR (bd.day_status = 'closed' AND bd.closed_at > $3::timestamptz - make_interval(hours => $4)))`,
    [restaurantId, businessDate, now.toISOString(), RECENT_CLOSE_HOURS]
  );

  const dayIds = days.rows.map((row) => row.id);
  const dayOf = new Map(days.rows.map((row) => [row.id, row]));
  const loose = `($2::date::timestamp AT TIME ZONE $3)`;
  const looseEnd = `(($2::date + 1)::timestamp AT TIME ZONE $3)`;

  const [bills, refunds, removed, closes] = await Promise.all([
    pool.query(
      `SELECT b.id, b.bill_number, b.bill_status, b.total_amount, b.subtotal,
              b.discount_amount - COALESCE(b.loyalty_discount, 0) AS discount, b.discount_code,
              b.void_reason, b.print_count, b.last_printed_at, b.billed_at, b.updated_at,
              b.business_day_id, u.name AS cashier
       FROM bills b
       LEFT JOIN users u ON u.id = b.created_by
       WHERE b.restaurant_id = $1
         AND (b.business_day_id = ANY($4::bigint[])
              OR (b.business_day_id IS NULL AND b.billed_at >= ${loose} AND b.billed_at < ${looseEnd})
              -- A bill from an older day voided today: the drawer for that day
              -- was counted long ago, so this is the void most worth seeing.
              OR b.id IN (SELECT a.entity_id FROM audit_logs a
                          WHERE a.restaurant_id = $1 AND a.action = 'void' AND a.entity_type = 'bill'
                            AND a.created_at >= ${loose}))
         AND (b.bill_status = 'void'
              OR b.print_count >= $5
              OR (b.bill_status <> 'void'
                  AND b.discount_amount - COALESCE(b.loyalty_discount, 0) > 0
                  AND (b.discount_amount - COALESCE(b.loyalty_discount, 0) >= $6
                       OR (b.subtotal > 0
                           AND (b.discount_amount - COALESCE(b.loyalty_discount, 0)) * 100 / b.subtotal >= $7))))`,
      [restaurantId, businessDate, timezone, dayIds, REPRINT_ALERT_PRINTS, LARGE_DISCOUNT_AMOUNT, LARGE_DISCOUNT_PERCENT]
    ),
    pool.query(
      `SELECT r.id, r.amount, r.refund_method, r.reason, r.refunded_at, r.business_day_id,
              b.id AS bill_id, b.bill_number, u.name AS refunded_by
       FROM refunds r
       JOIN bills b ON b.id = r.bill_id
       LEFT JOIN users u ON u.id = r.created_by
       WHERE r.restaurant_id = $1
         AND (r.business_day_id = ANY($4::bigint[])
              OR (r.business_day_id IS NULL AND r.refunded_at >= ${loose} AND r.refunded_at < ${looseEnd}))`,
      [restaurantId, businessDate, timezone, dayIds]
    ),
    pool.query(
      `SELECT c.id, c.item_name, c.variant_name, c.quantity, c.amount, c.kitchen_stage,
              c.reason_code, c.reason_note, c.created_at, c.business_day_id,
              o.order_number, u.name AS removed_by, ap.name AS approved_by
       FROM order_item_cancellations c
       JOIN orders o ON o.id = c.order_id
       LEFT JOIN users u ON u.id = c.cancelled_by
       LEFT JOIN users ap ON ap.id = c.approved_by
       -- An order cancelled after its bill was voided: the void has already
       -- rung for that money, so the dishes do not ring a second time.
       ${VOIDED_BILL_OF_REMOVAL("c")}
       WHERE c.restaurant_id = $1 AND c.after_kot AND vd.bill_number IS NULL
         AND (c.business_day_id = ANY($4::bigint[])
              OR (c.business_day_id IS NULL AND c.created_at >= ${loose} AND c.created_at < ${looseEnd}))`,
      [restaurantId, businessDate, timezone, dayIds]
    ),
    // The drawer arithmetic of each recently closed day — the main counter's
    // and each outlet's — exactly as on the day-end sheet (one definition,
    // report.repository DRAWER_EXPECTED): opening + cash taken − cash
    // refunded − cash expenses − cash paid to suppliers from the till.
    pool.query(
      `SELECT bd.id, bd.business_date::text AS business_date, bd.closed_at, bd.closing_cash,
              u.name AS closed_by, ol.name AS outlet_name,
              ${DRAWER_EXPECTED("bd")} AS expected_cash
       FROM business_days bd
       LEFT JOIN users u ON u.id = bd.closed_by
       LEFT JOIN outlets ol ON ol.id = bd.outlet_id
       WHERE bd.restaurant_id = $1 AND bd.id = ANY($2::bigint[])
         AND bd.day_status = 'closed' AND bd.closing_cash IS NOT NULL`,
      [restaurantId, dayIds]
    ),
  ]);

  // Who voided and who reprinted, and which manager allowed it, from the
  // activity log — the bill itself only knows who last touched it.
  const billIds = bills.rows.map((row) => row.id);
  const logs = billIds.length
    ? await pool.query(
        `SELECT DISTINCT ON (entity_id, action) entity_id, action, user_name, approver_name, created_at
         FROM audit_logs
         WHERE restaurant_id = $1 AND entity_type = 'bill' AND action IN ('void', 'reprint')
           AND entity_id = ANY($2::bigint[])
         ORDER BY entity_id, action, created_at DESC`,
        [restaurantId, billIds]
      )
    : { rows: [] };

  const logOf = new Map(logs.rows.map((row) => [`${row.entity_id}:${row.action}`, row]));
  const dateOfDay = (dayId) => (dayOf.get(dayId) ? dayOf.get(dayId).business_date : businessDate);
  const closedDay = (dayId) => {
    const day = dayOf.get(dayId);
    return day && day.day_status === "closed" ? day : null;
  };

  // --- Voids ------------------------------------------------------------
  const voids = bills.rows
    .filter((row) => row.bill_status === "void")
    .map((row) => {
      const log = logOf.get(`${row.id}:void`);
      const at = log ? log.created_at : row.updated_at;
      const day = closedDay(row.business_day_id);
      // Voided after its day was closed and counted: the drawer can no
      // longer show the difference, which is exactly why it is worth a look.
      const afterClose = Boolean(day && day.closed_at && new Date(at) > new Date(day.closed_at));
      const date = dateOfDay(row.business_day_id);

      return {
        id: `theft:void:${row.id}`,
        severity: afterClose ? "critical" : "warning",
        title: `${row.bill_number} voided — ${money(row.total_amount)}${afterClose ? " after the day was closed" : ""}`,
        detail: [who(log ? log.user_name : null, log ? log.approver_name : null), row.void_reason && `"${row.void_reason}"`]
          .filter(Boolean)
          .join(" · "),
        link: reportLink(date),
        category: "Theft control",
        at: new Date(at).toISOString(),
        // A void after the close outranks any amount.
        weight: Number(row.total_amount) + (afterClose ? 1e9 : 0),
        amount: Number(row.total_amount),
      };
    });

  // --- Refunds ----------------------------------------------------------
  const refundAlerts = refunds.rows.map((row) => ({
    id: `theft:refund:${row.id}`,
    severity: "warning",
    title: `${money(row.amount)} refunded on ${row.bill_number}`,
    detail: [row.refunded_by && `by ${row.refunded_by}`, row.refund_method, row.reason && `"${row.reason}"`]
      .filter(Boolean)
      .join(" · "),
    link: reportLink(dateOfDay(row.business_day_id)),
    category: "Theft control",
    at: new Date(row.refunded_at).toISOString(),
    weight: Number(row.amount),
    amount: Number(row.amount),
  }));

  // --- Large discounts --------------------------------------------------
  const discounts = bills.rows
    .filter((row) => row.bill_status !== "void" && Number(row.discount) > 0)
    .map((row) => {
      const percent = Number(row.subtotal) > 0 ? Math.round((Number(row.discount) * 100) / Number(row.subtotal)) : 0;
      return { row, percent };
    })
    .filter(
      ({ row, percent }) => Number(row.discount) >= LARGE_DISCOUNT_AMOUNT || percent >= LARGE_DISCOUNT_PERCENT
    )
    .map(({ row, percent }) => ({
      id: `theft:discount:${row.id}`,
      severity: percent >= HUGE_DISCOUNT_PERCENT ? "warning" : "info",
      title: `${percent}% off ${row.bill_number} — ${money(row.discount)} discount`,
      detail: [row.cashier && `billed by ${row.cashier}`, row.discount_code ? `code ${row.discount_code}` : "no coupon code"]
        .filter(Boolean)
        .join(" · "),
      link: reportLink(dateOfDay(row.business_day_id)),
      category: "Theft control",
      at: new Date(row.billed_at).toISOString(),
      weight: Number(row.discount),
      amount: Number(row.discount),
    }));

  // --- Reprints ---------------------------------------------------------
  // The print count is in the id, so the next reprint of the same bill
  // rings again.
  const reprints = bills.rows
    .filter((row) => row.print_count >= REPRINT_ALERT_PRINTS)
    .map((row) => {
      const log = logOf.get(`${row.id}:reprint`);
      return {
        id: `theft:reprint:${row.id}:${row.print_count}`,
        severity: "warning",
        title: `${row.bill_number} printed ${row.print_count} times`,
        detail: [
          `${money(row.total_amount)}`,
          row.bill_status === "void" ? "the bill is void" : null,
          log ? who(log.user_name, log.approver_name).replace(/^by/, "last by") : null,
          row.last_printed_at ? `at ${timeLabel(row.last_printed_at, timezone)}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        link: reportLink(dateOfDay(row.business_day_id)),
        category: "Theft control",
        at: new Date(row.last_printed_at || row.billed_at).toISOString(),
        weight: row.print_count * 1000 + Number(row.total_amount),
      };
    });

  // --- Dishes taken off after the kitchen had them ------------------------
  const removedAlerts = removed.rows.map((row) => {
    const served = row.kitchen_stage === "served";
    const stage = served ? "after it was served" : row.kitchen_stage === "ready" ? "when it was ready" : "after the KOT";
    const dish = row.variant_name ? `${row.item_name} (${row.variant_name})` : row.item_name;
    const reason = row.reason_code ? REASONS[row.reason_code] || row.reason_code : null;

    return {
      id: `theft:kot-cancel:${row.id}`,
      severity: served || row.kitchen_stage === "ready" ? "warning" : "info",
      title: `${dish} ×${Number(row.quantity)} taken off ${row.order_number} ${stage}`,
      detail: [
        money(row.amount),
        who(row.removed_by, row.approved_by),
        reason && `"${row.reason_note || reason}"`,
      ]
        .filter(Boolean)
        .join(" · "),
      link: reportLink(dateOfDay(row.business_day_id)),
      category: "Theft control",
      at: new Date(row.created_at).toISOString(),
      // Served and then taken off is the one to read first.
      weight: Number(row.amount) + (served ? 1e9 : 0),
      amount: Number(row.amount),
    };
  });

  // --- Cash short at close ----------------------------------------------
  const shortAlerts = closes.rows
    .map((row) => ({ row, short: Number(row.expected_cash) - Number(row.closing_cash) }))
    .filter(({ short }) => short >= CASH_SHORT_WARNING)
    .map(({ row, short }) => ({
      id: `theft:cash-short:${row.id}`,
      severity: short >= CASH_SHORT_CRITICAL ? "critical" : "warning",
      title: `Cash short by ${money(short)} at the close of ${row.outlet_name ? `${row.outlet_name}, ` : ""}${dateLabel(row.business_date)}`,
      detail: `Expected ${money(row.expected_cash)}, counted ${money(row.closing_cash)}${
        row.closed_by ? ` · closed by ${row.closed_by}` : ""
      }`,
      link: `/reports?tab=dayEnd&from=${row.business_date}&to=${row.business_date}`,
      category: "Theft control",
      at: new Date(row.closed_at).toISOString(),
      weight: short,
    }));

  const alerts = [
    ...shortAlerts,
    ...nameOrSummarise(voids, (rest) => ({
      id: `theft:voids:summary:${businessDate}`,
      severity: "warning",
      title: `${plural(rest.length, "more bill", "more bills")} voided`,
      detail: `${money(rest.reduce((sum, alert) => sum + alert.amount, 0))} in all · see who voided what`,
      link: reportLink(businessDate),
      category: "Theft control",
    })),
    ...nameOrSummarise(refundAlerts, (rest) => ({
      id: `theft:refunds:summary:${businessDate}`,
      severity: "warning",
      title: `${plural(rest.length, "more refund", "more refunds")} given`,
      detail: `${money(rest.reduce((sum, alert) => sum + alert.amount, 0))} in all`,
      link: reportLink(businessDate),
      category: "Theft control",
    })),
    ...nameOrSummarise(removedAlerts, (rest) => ({
      id: `theft:kot-cancels:summary:${businessDate}`,
      severity: "warning",
      title: `${plural(rest.length, "more dish", "more dishes")} taken off after the KOT`,
      detail: `${money(rest.reduce((sum, alert) => sum + alert.amount, 0))} in all`,
      link: reportLink(businessDate),
      category: "Theft control",
    })),
    ...nameOrSummarise(discounts, (rest) => ({
      id: `theft:discounts:summary:${businessDate}`,
      severity: "info",
      title: `${plural(rest.length, "more large discount", "more large discounts")}`,
      detail: `${money(rest.reduce((sum, alert) => sum + alert.amount, 0))} given away in all`,
      link: reportLink(businessDate),
      category: "Theft control",
    })),
    ...nameOrSummarise(reprints, (rest) => ({
      id: `theft:reprints:summary:${businessDate}`,
      severity: "info",
      title: `${plural(rest.length, "more bill", "more bills")} printed ${REPRINT_ALERT_PRINTS} times or more`,
      link: reportLink(businessDate),
      category: "Theft control",
    })),
  ];

  // weight and amount only choose which to name and add up a summary; the
  // bell does not need them.
  return alerts.map((alert) => {
    const clean = { ...alert };
    delete clean.weight;
    delete clean.amount;
    return clean;
  });
}

module.exports = {
  key: "theft",
  // Slow back-office checks: the answer is shared for this long (see the
  // cache in ../index.js). Live-service alerts declare none.
  cacheSeconds: 30,
  label: "Theft control",
  permission: "audit.view",

  collect: (context) => collectAlerts(completeContext(context)),

  // Exported for tests; the registry only calls collect().
  thresholds: {
    LARGE_DISCOUNT_PERCENT,
    LARGE_DISCOUNT_AMOUNT,
    REPRINT_ALERT_PRINTS,
    CASH_SHORT_WARNING,
    CASH_SHORT_CRITICAL,
    NAMED_LIMIT,
  },
};
