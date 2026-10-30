const pool = require("../../../../config/database");
const AppError = require("../../../../utils/AppError");
const auditRepository = require("../../../access/repositories/audit.repository");

// Restaurant features: the parts of the restaurant a restaurant may switch
// on or off (Settings -> Features). Each is an optional module in the
// platform catalogue (platform_modules) that applies to business type
// 'restaurant', and a restaurant's switch is a business_capabilities row of
// its business (migration 1791470000000). The database is the one source of
// truth:
//
//   restaurant_features(restaurant_id)   the codes switched on, read into the
//                                        signed-in profile on every request
//                                        (req.user.features)
//   restaurant_feature_set(...)          switches one, behind the capability
//                                        triggers (dependencies)
//
// This service adds what the database cannot know: whether switching a
// feature off would strand money (refused), or hide live data (a warning),
// and the activity log. The Business Admin's Modules screen for a restaurant
// business comes through here too, so both screens apply the same rules.

const OWNER_PERMISSION = "restaurant.settings.manage";
const WHERE = "Settings → Features";

let catalogue = null;

// The restaurant features in screen order, with what each needs. Read once
// per process: the catalogue only changes with a migration.
const loadCatalogue = async () => {
  if (!catalogue) {
    const result = await pool.query(
      `SELECT m.code, m.name, m.description, m.feature_group, m.sort_order, t.enabled_by_default,
              COALESCE((SELECT array_agg(d.requires_module_code ORDER BY d.requires_module_code)
                        FROM platform_module_dependencies d
                        WHERE d.module_code = m.code AND d.requires_module_code <> 'restaurant'), '{}') AS requires
       FROM platform_modules m
       JOIN platform_module_business_types t ON t.module_code = m.code AND t.business_type = 'restaurant'
       WHERE m.code <> 'restaurant' AND m.kind = 'optional'
       ORDER BY m.sort_order`
    );

    catalogue = result.rows.map((row) => ({
      code: row.code,
      name: row.name,
      description: row.description,
      group: row.feature_group || "Other",
      enabledByDefault: Boolean(row.enabled_by_default),
      requires: row.requires || [],
    }));

    for (const feature of catalogue) {
      feature.requiredBy = catalogue.filter((other) => other.requires.includes(feature.code)).map((other) => other.code);
    }
  }

  return catalogue;
};

const findFeature = async (code) => {
  const feature = (await loadCatalogue()).find((row) => row.code === code);

  if (!feature) {
    throw new AppError(404, "Feature not found");
  }

  return feature;
};

const nameOf = async (code) => (await loadCatalogue()).find((row) => row.code === code)?.name || code;

// The refusal every switched-off endpoint gives, naming the feature.
const offError = (name, code) =>
  new AppError(403, `${name} is switched off for this restaurant. An owner can switch it on in ${WHERE}.`, {
    reason: "feature_off",
    feature: code,
  });

const featuresOf = async (restaurantId, db = pool) => {
  if (!restaurantId) {
    return [];
  }

  const result = await db.query("SELECT restaurant_features($1) AS features", [restaurantId]);
  return result.rows[0]?.features || [];
};

// For a request whose profile already carries the list (req.user.features).
const has = (user, code) => Boolean(user && Array.isArray(user.features) && user.features.includes(code));

const assertOn = async (user, code) => {
  if (!has(user, code)) {
    throw offError(await nameOf(code), code);
  }
};

// For the public pages (QR code, booking link, online ordering link), which
// have no signed-in profile. A guest sees `guestMessage`; it still names the
// feature in `data` for the page to act on.
const assertRestaurantHas = async (restaurantId, code, guestMessage) => {
  const features = await featuresOf(restaurantId);

  if (!features.includes(code)) {
    if (guestMessage) {
      throw new AppError(403, guestMessage, { reason: "feature_off", feature: code });
    }

    throw offError(await nameOf(code), code);
  }

  return features;
};

// --- What switching a feature off would leave behind -------------------------

const n = (value) => Number(value || 0);
const money = (value) => `₹${n(value).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const plural = (count, one, many) => `${Number(count).toLocaleString("en-IN")} ${count === 1 ? one : many}`;
const first = async (db, sql, values) => (await db.query(sql, values)).rows[0] || {};

// blockers: money that would be stranded, so the switch is refused.
// warnings: live records that will be hidden (kept, and back when switched on).
const LIVE_DATA = {
  guests: async (db, rid) => {
    const warnings = [];
    const guests = await first(db, "SELECT count(*)::int AS n FROM customers WHERE restaurant_id = $1 AND erased_at IS NULL", [rid]);
    const open = await first(
      db,
      "SELECT count(*)::int AS n FROM complaints WHERE restaurant_id = $1 AND complaint_status NOT IN ('resolved', 'closed')",
      [rid]
    );

    if (guests.n) {
      warnings.push(`${plural(guests.n, "guest is", "guests are")} in the guest book. They are kept, and come back when Guests is switched on again.`);
    }

    if (open.n) {
      warnings.push(`${plural(open.n, "complaint is", "complaints are")} still open and will be hidden.`);
    }

    warnings.push("Bills already on a guest's account stay on Dues & accounts, where they can still be paid.");
    return { warnings };
  },
  guest_loyalty: async (db, rid) => {
    const held = await first(
      db,
      `SELECT count(*)::int AS n, COALESCE(SUM(points), 0)::int AS points FROM (
         SELECT customer_id, SUM(points) AS points FROM loyalty_transactions WHERE restaurant_id = $1
         GROUP BY customer_id HAVING SUM(points) > 0) t`,
      [rid]
    );

    return held.n
      ? { warnings: [`${plural(held.n, "guest holds", "guests hold")} ${held.points.toLocaleString("en-IN")} points. Nobody earns or uses points while Loyalty is off; their points are kept.`] }
      : {};
  },
  reservations: async (db, rid) => {
    const upcoming = await first(
      db,
      `SELECT count(*)::int AS n FROM reservations
       WHERE restaurant_id = $1 AND status IN ('requested', 'booked', 'confirmed') AND starts_at >= NOW() - INTERVAL '1 hour'`,
      [rid]
    );
    const waiting = await first(
      db,
      "SELECT count(*)::int AS n FROM waitlist_entries WHERE restaurant_id = $1 AND status IN ('waiting', 'notified')",
      [rid]
    );
    const warnings = [];

    if (upcoming.n) {
      warnings.push(`${plural(upcoming.n, "booking is", "bookings are")} still to come. They are kept but hidden, and the online booking link stops taking bookings.`);
    }

    if (waiting.n) {
      warnings.push(`${plural(waiting.n, "party is", "parties are")} on the waitlist.`);
    }

    return { warnings };
  },
  // The guests' requests waiting; a waiter's bill ask stays on Table requests.
  qr_ordering: async (db, rid) => {
    const pending = await first(
      db,
      `SELECT count(*)::int AS n FROM table_requests
       WHERE restaurant_id = $1 AND COALESCE(channel, 'qr') <> 'website' AND created_by IS NULL AND status IN ('pending', 'acknowledged', 'processing')`,
      [rid]
    );

    return pending.n
      ? { warnings: [`${plural(pending.n, "table request is", "table requests are")} waiting. Table QR codes stop taking orders and calls.`] }
      : { warnings: ["Table QR codes stop taking orders and calls."] };
  },
  online_ordering: async (db, rid) => {
    const pending = await first(
      db,
      "SELECT count(*)::int AS n FROM table_requests WHERE restaurant_id = $1 AND channel = 'website' AND status IN ('pending', 'acknowledged', 'processing')",
      [rid]
    );

    return pending.n
      ? { warnings: [`${plural(pending.n, "online order is", "online orders are")} waiting to be accepted. The ordering page stops taking orders.`] }
      : { warnings: ["The online ordering page stops taking orders."] };
  },
  deliveries: async (db, rid) => {
    const blockers = [];
    const warnings = [];
    const out = await first(
      db,
      `SELECT count(*)::int AS n FROM orders
       WHERE restaurant_id = $1 AND order_type = 'delivery' AND order_status = 'open' AND delivery_status = 'out_for_delivery'`,
      [rid]
    );
    const unpaid = await first(
      db,
      `SELECT count(*)::int AS n,
              COALESCE(SUM(b.total_amount - b.paid_amount - COALESCE(b.credited_amount, 0)), 0) AS amount
       FROM bills b JOIN orders o ON o.id = b.order_id
       WHERE b.restaurant_id = $1 AND o.order_type = 'delivery' AND o.delivery_status = 'delivered'
         AND o.rider_employee_id IS NOT NULL AND b.bill_status IN ('unpaid', 'partial')`,
      [rid]
    );
    const owed = await first(
      db,
      `SELECT count(*)::int AS n, COALESCE(SUM(shortfall), 0) AS amount FROM rider_settlements
       WHERE restaurant_id = $1 AND shortfall_action = 'owed' AND repaid_at IS NULL`,
      [rid]
    );
    const open = await first(
      db,
      `SELECT count(*)::int AS n FROM orders
       WHERE restaurant_id = $1 AND order_type = 'delivery' AND order_status = 'open'
         AND COALESCE(delivery_status, '') NOT IN ('out_for_delivery', 'delivered', 'cancelled')`,
      [rid]
    );

    if (out.n) {
      blockers.push(`${plural(out.n, "delivery is", "deliveries are")} out with a rider. Mark ${out.n === 1 ? "it" : "them"} delivered or returned first.`);
    }

    if (unpaid.n) {
      blockers.push(`Riders have not settled ${money(unpaid.amount)} on ${plural(unpaid.n, "delivered bill", "delivered bills")}. Settle rider cash first (Deliveries → Rider cash).`);
    }

    if (owed.n) {
      blockers.push(`${plural(owed.n, "rider still owes", "riders still owe")} ${money(owed.amount)} from a short settlement. Mark it repaid first.`);
    }

    if (open.n) {
      warnings.push(`${plural(open.n, "delivery order is", "delivery orders are")} still open. ${open.n === 1 ? "It stays" : "They stay"} on Orders and can be billed there.`);
    }

    return { blockers, warnings };
  },
  kitchen_display: async () => ({ warnings: ["Kitchen screens stop showing tickets. KOTs keep printing as before."] }),
  preorders: async (db, rid) => {
    const open = await first(
      db,
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE advance_id IS NOT NULL)::int AS advances
       FROM restaurant_preorders WHERE restaurant_id = $1 AND status IN ('booked', 'in_production', 'ready')`,
      [rid]
    );

    return open.n
      ? {
          warnings: [
            `${plural(open.n, "pre-order is", "pre-orders are")} still open (booked, in production or ready). ${open.n === 1 ? "It is" : "They are"} kept but hidden: nobody can bake, hand over or cancel ${open.n === 1 ? "it" : "them"} until Pre-orders & cakes is switched back on.${open.advances ? ` ${plural(open.advances, "advance taken for them stays", "advances taken for them stay")} under Dues & accounts › Advances.` : ""}`,
          ],
        }
      : {};
  },
  captain_sections: async (db, rid) => {
    const today = await first(db, "SELECT count(DISTINCT user_id)::int AS n FROM captain_assignments WHERE restaurant_id = $1 AND shift_date >= CURRENT_DATE - 1", [rid]);

    return today.n
      ? { warnings: [`${plural(today.n, "captain has", "captains have")} tables assigned today. Every captain will see every table.`] }
      : {};
  },
  tips: async (db, rid) => {
    const unshared = await first(
      db,
      `SELECT count(*)::int AS n, COALESCE(SUM(p.tip_amount), 0) AS amount
       FROM payments p JOIN bills b ON b.id = p.bill_id
       WHERE p.restaurant_id = $1 AND p.tip_amount > 0 AND p.payment_status = 'success' AND b.bill_status <> 'void'
         AND p.paid_at >= NOW() - INTERVAL '62 days'
         AND NOT EXISTS (SELECT 1 FROM tip_shareout_payments sp WHERE sp.payment_id = p.id)`,
      [rid]
    );

    return unshared.n
      ? { warnings: [`${money(unshared.amount)} of tips taken is not shared out yet. It stays recorded; share it out once Tips is back on.`] }
      : {};
  },
  advances: async (db, rid) => {
    const held = await first(
      db,
      `SELECT count(*)::int AS n, COALESCE(SUM(amount - used_amount - refunded_amount), 0) AS amount
       FROM customer_advances WHERE restaurant_id = $1 AND used_amount + refunded_amount < amount`,
      [rid]
    );

    return held.n
      ? { blockers: [`${plural(held.n, "advance still holds", "advances still hold")} ${money(held.amount)} of guests' money. Use ${held.n === 1 ? "it" : "them"} on a bill or refund ${held.n === 1 ? "it" : "them"} first (Dues & accounts → Advances).`] }
      : {};
  },
  cash_drawers: async (db, rid) => {
    const open = await first(db, "SELECT count(*)::int AS n FROM cash_drawers WHERE restaurant_id = $1 AND drawer_status = 'open'", [rid]);

    return open.n
      ? { blockers: [`${plural(open.n, "cash drawer is", "cash drawers are")} still open. Count and end ${open.n === 1 ? "it" : "them"} first (Business day → Drawers & cash).`] }
      : { warnings: ["The business day goes back to one till, counted at day end."] };
  },
  coupons: async (db, rid) => {
    const active = await first(db, "SELECT count(*)::int AS n FROM discounts WHERE restaurant_id = $1 AND status = 'active'", [rid]);

    return active.n
      ? { warnings: [`${plural(active.n, "discount or offer is", "discounts and offers are")} set up. They stop applying at the till and are kept.`] }
      : {};
  },
  stock_recipes: async (db, rid) => {
    const open = await first(
      db,
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE po_status = 'draft')::int AS drafts,
              COALESCE(SUM(total_amount) FILTER (WHERE po_status <> 'draft'), 0) AS amount
       FROM purchase_orders WHERE restaurant_id = $1 AND po_status IN ('draft', 'pending_approval', 'ordered', 'partial')`,
      [rid]
    );
    const owed = await first(
      db,
      `SELECT count(*)::int AS n, COALESCE(SUM(owed), 0) AS amount FROM (
         SELECT s.id,
                COALESCE((SELECT SUM(total_amount) FROM goods_receipts g WHERE g.restaurant_id = $1 AND g.supplier_id = s.id AND g.receipt_status = 'posted'), 0)
              - COALESCE((SELECT SUM(amount) FROM supplier_payments sp WHERE sp.restaurant_id = $1 AND sp.supplier_id = s.id AND sp.payment_status = 'posted'), 0)
              - COALESCE((SELECT SUM(total_amount) FROM purchase_returns r WHERE r.restaurant_id = $1 AND r.supplier_id = s.id AND r.return_status = 'posted'), 0) AS owed
         FROM suppliers s WHERE s.restaurant_id = $1) t
       WHERE owed > 0.004`,
      [rid]
    );
    const blockers = [];
    const warnings = ["Stock is still taken off for what is sold, so the numbers are right when Stock is switched back on."];

    if (owed.n) {
      blockers.push(`${money(owed.amount)} is still owed to ${plural(owed.n, "supplier", "suppliers")}. Pay or settle their bills first (Purchases & suppliers → Returns & payments).`);
    }

    if (open.n) {
      const placed = open.n - open.drafts;
      warnings.push(
        `${plural(open.n, "purchase order is", "purchase orders are")} still open (${[
          open.drafts ? plural(open.drafts, "draft", "drafts") : null,
          placed ? `${plural(placed, "placed", "placed")} for ${money(open.amount)}` : null,
        ]
          .filter(Boolean)
          .join(", ")}). They stay saved but hidden.`
      );
    }

    return { blockers, warnings };
  },
  staff_payroll: async (db, rid) => {
    const clockedIn = await first(
      db,
      `SELECT count(*)::int AS n FROM employees e
       WHERE e.restaurant_id = $1 AND e.status = 'active'
         AND (SELECT ap.punch_type FROM attendance_punches ap WHERE ap.employee_id = e.id ORDER BY ap.punched_at DESC, ap.id DESC LIMIT 1) IN ('clock_in', 'break_start', 'break_end')`,
      [rid]
    );

    return clockedIn.n
      ? { warnings: [`${plural(clockedIn.n, "person is", "people are")} clocked in now. The time clock stops until Staff is switched back on.`] }
      : {};
  },
};

// The screens and reports a feature's switch-off takes away, in the words of
// the menu, for the Features screen's "Switch off?" question.
const HIDES = {
  guests: ["Customers (guest book)", "Feedback", "Complaints", "Guest insights", "Guest reports"],
  guest_loyalty: ["Points at the till", "Points on bills and receipts", "Loyalty report"],
  reservations: ["Reservations", "Waitlist", "The online booking link"],
  qr_ordering: ["Table QR ordering and call-staff", "Table requests (QR orders)"],
  online_ordering: ["The online ordering page", "Table requests (online orders)"],
  deliveries: ["Deliveries", "Riders and rider cash", "Sales channels"],
  kitchen_display: ["Kitchen display"],
  preorders: ["Pre-orders & cakes", "The bake list", "Pre-orders on the dashboard"],
  captain_sections: ["Captain sections on the floor plan"],
  tips: ["Tips", "The tip box at payment", "Tips on payroll"],
  advances: ["Advances & deposits"],
  cash_drawers: ["Drawers per shift (Business day → Drawers & cash)"],
  coupons: ["Discounts & offers", "Coupons at the till"],
  stock_recipes: [
    "Items & stock",
    "Stock movements",
    "Waste & reorder",
    "Transfers & indents",
    "Suppliers",
    "Purchase orders",
    "Returns & payments",
    "Stock and food-cost reports",
  ],
  staff_payroll: ["Employees", "Shifts & roster", "Attendance", "Time clock", "Payroll", "My work"],
};

// What stands in the way of a change, and what it will hide. Dependencies
// first: they decide whether the change can happen at all.
const assess = async (db, restaurantId, features, feature, enabled) => {
  const blockers = [];
  const warnings = [];

  if (enabled) {
    for (const code of feature.requires) {
      if (!features.includes(code)) {
        blockers.push(`${feature.name} needs ${await nameOf(code)}. Switch that on first.`);
      }
    }

    return { blockers, warnings };
  }

  for (const code of feature.requiredBy) {
    if (features.includes(code)) {
      blockers.push(`${await nameOf(code)} needs ${feature.name}. Switch ${await nameOf(code)} off first.`);
    }
  }

  const live = LIVE_DATA[feature.code] ? await LIVE_DATA[feature.code](db, restaurantId) : {};
  blockers.push(...(live.blockers || []));
  warnings.push(...(live.warnings || []));

  return { blockers, warnings };
};

// --- The Features screen ------------------------------------------------------

const requireRestaurant = (user) => {
  if (!user.restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const canChange = (user) => Boolean(user.permissions && user.permissions.includes(OWNER_PERMISSION));

const listFor = async (restaurantId, db = pool) => {
  const features = await featuresOf(restaurantId, db);

  return (await loadCatalogue()).map((feature) => ({ ...feature, enabled: features.includes(feature.code) }));
};

const list = async (user) => {
  requireRestaurant(user);

  return { features: await listFor(user.restaurantId), canChange: canChange(user) };
};

// What switching one feature would do, before the owner confirms it.
const preview = async (user, code, enabled) => {
  requireRestaurant(user);
  const feature = await findFeature(code);
  const features = await featuresOf(user.restaurantId);

  if (features.includes(code) === enabled) {
    return { code, enabled, changed: false, blockers: [], warnings: [] };
  }

  return {
    code,
    enabled,
    changed: true,
    // Switching off: the screens and reports that go with it.
    hides: enabled ? [] : HIDES[code] || [],
    ...(await assess(pool, user.restaurantId, features, feature, enabled)),
  };
};

// Switches one feature for one restaurant, inside one transaction holding the
// restaurant's business row, so two owners switching at once queue up and
// each decision is made on what the other left.
const apply = async ({ restaurantId, actor, code, enabled, via }) => {
  const feature = await findFeature(code);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const business = (await client.query("SELECT restaurant_business_id($1) AS id", [restaurantId])).rows[0].id;
    await client.query("SELECT id FROM businesses WHERE id = $1 FOR UPDATE", [business]);
    const features = await featuresOf(restaurantId, client);

    if (features.includes(code) === enabled) {
      await client.query("COMMIT");
      return { code, enabled, changed: false, warnings: [] };
    }

    const { blockers, warnings } = await assess(client, restaurantId, features, feature, enabled);

    if (blockers.length) {
      throw new AppError(409, `${feature.name} cannot be switched ${enabled ? "on" : "off"} yet: ${blockers[0]}`, {
        reason: "feature_blocked",
        feature: code,
        blockers,
        warnings,
      });
    }

    await client.query("SELECT restaurant_feature_set($1, $2, $3, $4)", [restaurantId, code, enabled, actor.id]);

    await auditRepository.record(
      {
        restaurantId,
        userId: actor.id,
        userName: actor.name,
        action: enabled ? "feature.enabled" : "feature.disabled",
        entityType: "restaurant_feature",
        entityLabel: feature.name,
        details: { feature: code, via, ...(warnings.length ? { warnings } : {}) },
      },
      client
    );
    await client.query(
      "INSERT INTO business_audit (business_id, actor_id, action, details) VALUES ($1, $2, $3, $4)",
      [business, actor.id, enabled ? "module.enabled" : "module.disabled", JSON.stringify({ module: code, via })]
    );

    await client.query("COMMIT");
    return { code, enabled, changed: true, warnings };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    // The capability triggers are the backstop for dependencies.
    if (error.code === "23514") {
      throw new AppError(409, error.message, { reason: "feature_blocked", feature: code });
    }

    throw error;
  } finally {
    client.release();
  }
};

const set = async (user, code, enabled) => {
  requireRestaurant(user);

  if (!canChange(user)) {
    throw new AppError(403, "Only the owner can switch features on or off");
  }

  if (typeof enabled !== "boolean") {
    throw new AppError(400, "Say whether the feature should be on or off");
  }

  const result = await apply({ restaurantId: user.restaurantId, actor: user, code, enabled, via: "settings" });
  return { ...result, features: await listFor(user.restaurantId) };
};

// The Business Admin's Modules switch for a restaurant business (permission
// settings.edit in that business, checked by the caller).
const setForBusiness = async (business, actor, code, enabled) => {
  if (!business.legacy_restaurant_id) {
    throw new AppError(409, "This restaurant business is not linked to a restaurant");
  }

  const name = actor.name || (await pool.query("SELECT name FROM users WHERE id = $1", [actor.id])).rows[0]?.name;
  return apply({ restaurantId: business.legacy_restaurant_id, actor: { id: actor.id, name }, code, enabled, via: "business_admin" });
};

const isFeature = async (code) => (await loadCatalogue()).some((row) => row.code === code);

module.exports = {
  OWNER_PERMISSION,
  featuresOf,
  has,
  assertOn,
  assertRestaurantHas,
  offError,
  list,
  preview,
  set,
  setForBusiness,
  isFeature,
  apply,
};
