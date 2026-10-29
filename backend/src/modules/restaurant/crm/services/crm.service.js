const pool = require("../../../../config/database");
const crmRepository = require("../repositories/crm.repository");
const loyaltyRepository = require("../repositories/loyalty.repository");
const AppError = require("../../../../utils/AppError");
const ruleSettings = require("../../setup/services/ruleSettings.service");
const { round2 } = require("../../../../utils/money");
const {
  abroadTenCountry,
  formatMobile,
  maskMobile,
  mobileSearchDigits,
  normaliseMobile,
  readMobile,
  tenDigitTwin,
} = require("../../../../utils/phone");
const { gstinState } = require("../../../../utils/gstin");
const { maskPan } = require("../../../gst-thresholds/services/gstThresholdsRules");

const DUPLICATE = "23505";

// The legacy list (the till's search) answers with at most this many rows and
// says how many matched in a header. The guest book pages instead.
const DEFAULT_LIST_LIMIT = 500;
// One CSV holds at most this many guests; the export says when there were more.
const EXPORT_CAP = 20000;

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

// "p•••a@gmail.com": enough to recognise, not enough to copy.
const maskEmail = (email) => {
  if (!email) {
    return null;
  }

  const [user, domain] = String(email).split("@");

  if (!domain) {
    return "•••";
  }

  return `${user.slice(0, 1)}•••${user.length > 1 ? user.slice(-1) : ""}@${domain}`;
};

// A guest as the screens see them. Staff without customers.contact (cashiers,
// floor roles given the guest book) see a masked mobile and email and no
// address: they can confirm "the one ending 3210" without being able to page
// through the book and copy every regular's number. The real mobile is then
// null, so nothing on screen can copy a masked number into an order by
// mistake.
const toCustomer = (row, reveal = true) => ({
  id: row.id,
  name: row.name,
  mobile: reveal ? row.mobile : null,
  mobileMasked: row.mobile ? maskMobile(row.mobile) : null,
  mobileDisplay: row.mobile ? (reveal ? formatMobile(row.mobile) : maskMobile(row.mobile)) : null,
  email: reveal ? row.email : null,
  emailMasked: row.email ? maskEmail(row.email) : null,
  address: reveal ? row.address : null,
  contactHidden: !reveal,
  dateOfBirth: row.date_of_birth,
  anniversaryDate: row.anniversary_date ?? null,
  loyaltyPoints: row.loyalty_points,
  notes: row.notes,
  status: row.status,
  createdAt: row.created_at,
  companyName: row.company_name ?? null,
  gstin: row.gstin ?? null,
  gstState: gstinState(row.gstin),
  tags: row.tags || [],
  allergies: row.allergies ?? null,
  marketingOptIn: Boolean(row.marketing_opt_in),
  marketingOptInAt: row.marketing_opt_in_at ?? null,
  duplicateOf: row.duplicate_of ?? null,
  erased: Boolean(row.erased_at),
  erasedAt: row.erased_at ?? null,
  // The guest's PAN, for a bill over ₹2,00,000: in full for staff who see
  // guests' contact details, its last four characters for everyone else.
  // Or the guest's declaration that they have none (Form 97).
  pan: reveal ? row.pan || null : null,
  panMasked: row.pan ? maskPan(row.pan) : null,
  panDeclaration: Boolean(row.pan_declaration),
});

// What a guest's PAN record changed, for the activity log, with the PAN
// masked (the log is read by people who may not see it): { pan: [before,
// after] } and { panDeclaration: [before, after] } where they moved, or null.
const panChangeOf = (before, after) => {
  const changes = {};

  if ((before.pan || null) !== (after.pan || null)) {
    changes.pan = [before.pan ? maskPan(before.pan) : null, after.pan ? maskPan(after.pan) : null];
  }

  if (Boolean(before.pan_declaration) !== Boolean(after.pan_declaration)) {
    changes.panDeclaration = [Boolean(before.pan_declaration), Boolean(after.pan_declaration)];
  }

  return Object.keys(changes).length > 0 ? changes : null;
};

const toBookRow = (row, reveal) => ({
  ...toCustomer(row, reveal),
  visits: Number(row.visits || 0),
  lastVisit: row.last_visit || null,
  spend: round2(Number(row.spend || 0)),
});

const maskedContact = (mobile, reveal) => (mobile ? (reveal ? mobile : maskMobile(mobile)) : null);

const toFeedback = (row, reveal = true) => ({
  id: row.id,
  customerId: row.customer_id,
  customerName: row.linked_customer_name || row.customer_name,
  customerMobile: maskedContact(row.customer_mobile, reveal),
  rating: row.rating,
  comments: row.comments,
  source: row.source,
  feedbackStatus: row.feedback_status,
  createdAt: row.created_at,
});

const toComplaint = (row, reveal = true) => ({
  id: row.id,
  customerId: row.customer_id,
  customerName: row.customer_name,
  customerMobile: maskedContact(row.customer_mobile, reveal),
  subject: row.subject,
  description: row.description,
  category: row.category,
  priority: row.priority,
  complaintStatus: row.complaint_status,
  assignedTo: row.assigned_to,
  assignedToName: row.assigned_to_name,
  resolution: row.resolution,
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
  billId: row.bill_id ?? null,
  billNumber: row.bill_number ?? null,
  orderId: row.order_id ?? null,
  orderNumber: row.order_number ?? null,
  compensationType: row.compensation_type ?? null,
  compensationValue: round2(Number(row.compensation_value || 0)),
  compensationNotes: row.compensation_notes ?? null,
  outletId: row.outlet_id ?? null,
});

// A search box holds a name or part of a mobile written any way; the digits
// of a number are searched as digits, anything else as text.
//
// For staff who see numbers masked (reveal false), part of a number finds a
// guest only by what they can already read, the last 4 digits, or by the
// whole number (the guest is in front of them). Anything in between would let
// a cashier rebuild a hidden number: type 2812, then 02812, 102812… and watch
// which guest stays in the list. Such a search matches no mobile and says so
// (limited), and on the complaints list it still finds bill numbers. Emails
// are masked for them too, so an email matches only when typed in full.
const LAST_DIGITS_SHOWN = 4;

const readSearch = (search, reveal = true) => {
  if (!search) {
    return { name: null, digits: null };
  }

  const digits = mobileSearchDigits(search);

  if (!digits) {
    return { name: String(search).trim(), digits: null, emailExact: !reveal };
  }

  if (reveal) {
    return { name: null, digits };
  }

  const whole = normaliseMobile(search);

  if (whole) {
    return { name: null, digits, mobilePattern: whole };
  }

  if (digits.length <= LAST_DIGITS_SHOWN) {
    return { name: null, digits, mobilePattern: `%${digits}` };
  }

  // An empty pattern matches no mobile. The digits still find a bill or
  // order number on the complaints list.
  return { name: null, digits, mobilePattern: "", limited: true };
};

// A cashier who typed a guest's whole number already knows it: the guest is at
// the counter or on the phone, and the till needs the number on the order.
// That one guest's mobile comes back as typed; their email and address stay
// hidden (knowing someone's phone number must not be a way to learn where
// they live), and everyone else in the list stays masked. Only staff who
// attach guests to orders (customers.manage) get this; a view-only role sees
// every number masked.
const typedMobileOf = (search) => (search ? normaliseMobile(search) : null);

const toListedCustomer = (row, reveal, typedMobile) => {
  if (reveal || typedMobile === null || row.mobile !== typedMobile) {
    return toCustomer(row, reveal);
  }

  return { ...toCustomer(row, false), mobile: row.mobile, mobileDisplay: formatMobile(row.mobile) };
};

const pageOf = (result, limit, offset, map) => ({
  items: result.rows.map(map),
  total: result.total ?? 0,
  limit,
  offset,
});

// --- Customers ---

// The till's quick search (and the older screens): a plain list, with how
// many matched in `total` so a caller can tell when it is not all of them.
const listCustomers = async (restaurantId, filters = {}, options = {}) => {
  requireRestaurantId(restaurantId);

  const { reveal = true, withTotal = false, revealTyped = false } = options;
  const typed = revealTyped ? typedMobileOf(filters.search) : null;
  const terms = readSearch(filters.search, reveal);
  const result = await crmRepository.searchCustomers(restaurantId, {
    ...terms,
    limit: filters.limit || DEFAULT_LIST_LIMIT,
    includeErased: false,
  });
  const items = result.rows.map((row) => toListedCustomer(row, reveal, typed));

  return withTotal ? { items, total: result.total, searchLimited: Boolean(terms.limited) } : items;
};

// The guest book: every guest, a page at a time, with visits, last visit and
// spend, sortable, filterable, and counted. searchLimited: part of a number
// was typed that only the whole number or its last 4 digits can find, for
// this person (see readSearch); the screen says so.
const listGuestBook = async (restaurantId, filters, reveal, options = {}) => {
  requireRestaurantId(restaurantId);

  const typed = options.revealTyped ? typedMobileOf(filters.search) : null;
  const terms = readSearch(filters.search, reveal);
  // A quick view (occasion this week, lapsed) counts from the restaurant's
  // today; "lapsed" is the restaurant's own line, the one Guest insights uses.
  const [today, rules] = await Promise.all([
    filters.view ? todayFor(restaurantId) : null,
    ruleSettings.load(restaurantId),
  ]);
  const [page, counts] = await Promise.all([
    crmRepository.findGuestBook(restaurantId, { ...filters, ...terms, today, lapsedDays: rules.guestLapsedDays }),
    crmRepository.guestBookCounts(restaurantId),
  ]);

  return {
    ...pageOf(page, filters.limit, filters.offset, (row) => ({
      ...toBookRow(row, reveal),
      ...toListedCustomer(row, reveal, typed),
    })),
    counts,
    // So the "Lapsed" view can say how many days it means.
    lapsedDays: rules.guestLapsedDays,
    searchLimited: Boolean(terms.limited),
  };
};

// Every matching guest, for a CSV. Only for holders of customers.export
// (checked on the route); written to the activity log by the controller. The
// contact columns are full for those who may see them (owners and managers
// have both), masked otherwise.
const exportGuestBook = async (restaurantId, filters, reveal = true) => {
  requireRestaurantId(restaurantId);

  const [today, rules] = await Promise.all([
    filters.view ? todayFor(restaurantId) : null,
    ruleSettings.load(restaurantId),
  ]);
  const page = await crmRepository.findGuestBookForExport(
    restaurantId,
    { ...filters, ...readSearch(filters.search, reveal), today, lapsedDays: rules.guestLapsedDays },
    EXPORT_CAP
  );

  return {
    items: page.rows.map((row) => toBookRow(row, reveal)),
    total: page.total ?? 0,
    cap: EXPORT_CAP,
    truncated: (page.total ?? 0) > EXPORT_CAP,
  };
};

const inTransaction = async (work) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Who already holds this number, or the same ten digits in its other form
// (utils/phone.js tenDigitTwin). The same number is always refused. The other
// form is refused too, unless the person saving has confirmed it is a
// different number (confirmed): "+9598473967" typed for a guest who is
// 9598473967 is nearly always the 91 left out, but a real number from
// Myanmar and a real Indian one can share ten digits. The sentence only
// repeats digits the person has just typed.
const mobileTaken = async (client, restaurantId, mobile, exceptId = null, confirmed = false) => {
  const twin = tenDigitTwin(mobile);
  const holders = (await crmRepository.findCustomersByMobiles(client, restaurantId, [mobile, twin])).filter(
    (row) => row.id !== exceptId
  );
  const same = holders.find((row) => row.mobile === mobile);

  if (same) {
    return new AppError(
      409,
      `${same.name} already has the mobile ${formatMobile(mobile)}. Open their record instead of adding the same guest twice.`,
      { existingId: same.id, existingName: same.name }
    );
  }

  const other = twin ? holders.find((row) => row.mobile === twin) : null;

  if (!other || confirmed) {
    return null;
  }

  const abroad = mobile.startsWith("+");
  const country = abroadTenCountry(mobile) || "abroad";

  return new AppError(
    409,
    abroad
      ? `${other.name} already has the Indian mobile ${formatMobile(twin)}. “${mobile}” is the same ten digits with a + in front, ` +
          `which is how a mobile from ${country} is written. If it is ${other.name}'s number, open their record. ` +
          `If this guest's number really is from ${country}, confirm that and save again.`
      : `${other.name} already has ${twin}, a mobile from ${country} with the same ten digits. ` +
          `If this is ${other.name}, open their record. If it is a different, Indian mobile, confirm that and save again.`,
    { reason: "same_digits", existingId: other.id, existingName: other.name, country }
  );
};

// Every writer goes through here: a mobile is stored in the one format
// (utils/phone.js), whatever was typed.
const tidyCustomerData = (data) => ({
  ...data,
  // Left out (undefined) on an edit means "keep what is on file".
  mobile: data.mobile === undefined ? undefined : readMobile(data.mobile, "Mobile"),
});

// The check and the insert happen under a lock on the number's ten digits, so
// two saves of one guest in two writings, sent at the same moment, cannot both
// pass the check. data.sameDigitsConfirmed: see mobileTaken.
const createCustomer = async (restaurantId, data, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  const tidy = tidyCustomerData({ ...data, status: data.status || "active" });

  return inTransaction(async (client) => {
    if (tidy.mobile) {
      await crmRepository.lockMobile(client, restaurantId, tidy.mobile);
      const taken = await mobileTaken(client, restaurantId, tidy.mobile, null, data.sameDigitsConfirmed === true);

      if (taken) {
        throw taken;
      }
    }

    try {
      const row = await crmRepository.createCustomer(restaurantId, tidy, userId, client);
      const choices = consentChoices(data);

      if (!choices) {
        return toCustomer(row);
      }

      // Consent given as the guest is added: a record of its own, with the notice shown.
      await personalData().applyGuestChoices(client, restaurantId, row.id, choices, { id: userId, name: options.userName || null });
      const [saved] = await crmRepository.lockCustomers(client, restaurantId, [row.id]);

      return toCustomer(saved);
    } catch (error) {
      if (error.code === DUPLICATE) {
        throw new AppError(409, "A customer with this mobile number already exists");
      }

      throw error;
    }
  });
};

// What a form says about the guest's consents: data.consents ({ bills_digital,
// reminders, offers }, each yes or no), or the older offers box alone
// (data.marketingOptIn). null when it says nothing.
const consentChoices = (data) => {
  const choices = { ...(data.consents || {}) };

  if (typeof data.marketingOptIn === "boolean" && choices.offers === undefined) {
    choices.offers = data.marketingOptIn;
  }

  return Object.keys(choices).length ? choices : null;
};

// The contact details a masked edit form cannot show, and so never sends back.
const HIDDEN_CONTACT = [
  ["mobile", "mobile"],
  ["email", "email"],
  ["address", "address"],
];

// Fields an edit may leave out, each kept as it is when it does.
const KEPT_WHEN_LEFT_OUT = [
  ...HIDDEN_CONTACT,
  ["dateOfBirth", "date_of_birth"],
  ["notes", "notes"],
  ["status", "status"],
];

// An edit, with the record as it was, so the controller can log what changed
// (consent given or withdrawn, a GSTIN added).
//
// options.keepHiddenContact: the person editing cannot see this guest's
// mobile, email or address (no customers.contact), so their form shows those
// boxes empty. An empty box then means "unchanged", not "remove it": a
// cashier fixing a name must not wipe the number. A new number typed in is
// still saved (the guest has changed phones). options.reveal decides what the
// answer shows, as for any read.
const editCustomer = async (restaurantId, id, data, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  const { keepHiddenContact = false, reveal = true } = options;
  const erasedRefusal = () =>
    new AppError(409, "This guest's details were erased at their request, so the record can no longer be edited");
  const found = await crmRepository.findCustomerById(restaurantId, id);

  if (!found) {
    throw new AppError(404, "Customer not found");
  }

  if (found.erased_at) {
    throw erasedRefusal();
  }

  return inTransaction(async (client) => {
    // The guest is locked and read again here, inside the transaction that
    // writes the edit. Checked only beforehand, an erase landing between the
    // check and the write left the erased record holding the edited name and
    // number again — what the guest asked to have removed. Now the erase and
    // the edit go one after the other: an edit that comes second is refused.
    //
    // Changing a guest's GSTIN, company name or address never touches their
    // bills: every tax invoice carries its buyer on the bill from the moment
    // it was raised (bill_gst_recipients), and the GST pack, the day book and
    // the reprint read only that. So no bill is locked or written here.
    const [existing] = await crmRepository.lockCustomers(client, restaurantId, [id]);

    if (!existing) {
      throw new AppError(404, "Customer not found");
    }

    if (existing.erased_at) {
      throw erasedRefusal();
    }

    const tidy = tidyCustomerData(data);

    for (const [field, column] of KEPT_WHEN_LEFT_OUT) {
      if (tidy[field] === undefined) {
        tidy[field] = existing[column];
      }
    }

    if (keepHiddenContact) {
      for (const [field, column] of HIDDEN_CONTACT) {
        if (tidy[field] === null || tidy[field] === undefined) {
          tidy[field] = existing[column];
        }
      }

      // The PAN is masked for them too: an empty box with no declaration
      // ticked keeps what is on file.
      if (!tidy.pan && !tidy.panDeclaration && (tidy.pan !== undefined || tidy.panDeclaration !== undefined)) {
        tidy.pan = existing.pan || null;
        tidy.panDeclaration = Boolean(existing.pan_declaration);
      }
    }

    // Checked only when the number changes: a guest keeps the number they
    // have even if someone else was later saved with its other form.
    if (tidy.mobile && tidy.mobile !== existing.mobile) {
      await crmRepository.lockMobile(client, restaurantId, tidy.mobile);
      const taken = await mobileTaken(
        client,
        restaurantId,
        tidy.mobile,
        existing.id,
        data.sameDigitsConfirmed === true
      );

      if (taken) {
        throw taken;
      }
    }

    try {
      let row = await crmRepository.updateCustomer(restaurantId, id, tidy, userId, client);

      if (!row) {
        throw new AppError(404, "Customer not found");
      }

      // A change to their consents is a consent given or withdrawn, recorded as such.
      const choices = consentChoices(data);

      if (choices) {
        await personalData().applyGuestChoices(client, restaurantId, id, choices, { id: userId, name: options.userName || null });
        [row] = await crmRepository.lockCustomers(client, restaurantId, [id]);
      }

      return { before: toCustomer(existing), after: toCustomer(row, reveal), panChange: panChangeOf(existing, row) };
    } catch (error) {
      if (error.code === DUPLICATE) {
        throw new AppError(409, "A customer with this mobile number already exists");
      }

      throw error;
    }
  });
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// Deleting outright is for a record added by mistake. A guest with any
// history is erased instead: the bills must be kept (GST law), and deleting
// the record would take their points ledger with it. options.canErase: the
// person asking may erase (the sentence then points them at it; a cashier is
// told to ask a manager).
const removeCustomer = async (restaurantId, id, options = {}) => {
  requireRestaurantId(restaurantId);

  const { canErase = true } = options;

  const customer = await crmRepository.findCustomerById(restaurantId, id);

  if (!customer) {
    throw new AppError(404, "Customer not found");
  }

  const history = await crmRepository.historyCounts(restaurantId, id);
  const held = [
    history.orders && plural(history.orders, "order"),
    history.feedback && `${history.feedback} feedback`,
    history.complaints && plural(history.complaints, "complaint"),
    history.points && plural(history.points, "points entry").replace("entrys", "entries"),
    // Consents and requests are kept as the record of what the guest agreed to and asked.
    history.consents && plural(history.consents, "consent or request").replace("consent or requests", "consents or requests"),
  ].filter(Boolean);

  if (held.length > 0) {
    throw new AppError(
      409,
      `${customer.name} has ${held.join(", ")} on record, so the record cannot be deleted: bills must be kept. ` +
        (canErase
          ? "If the guest asked for their data to be removed, use “Erase personal details”, which keeps the bills and removes who they are."
          : "If the guest asked for their data to be removed, ask a manager to erase their personal details: the bills stay, who they are goes."),
      { reason: "has_history", history }
    );
  }

  const removed = await crmRepository.removeCustomer(restaurantId, id);

  if (!removed) {
    throw new AppError(404, "Customer not found");
  }

  return toCustomer(customer);
};

// A guest's request to delete their data (DPDP Act). Everything that says who
// they were is removed, here and in every copy (feedback, complaints, orders,
// bookings); the bills, visit counts and sales stay. Points still owed are
// cancelled with a ledger entry, so the points liability report drops them.
// An order still open, a booking not yet seated and a party still waiting
// carry on as walk-ins, so nothing can earn points for the erased record
// afterwards (see crm.repository detachLiveRecords). Money still between the
// guest and the restaurant (dues on account, an advance, a pre-order to
// collect) is settled first. Their consents stop and a child's mark ends,
// both kept as the record (modules/personal-data). options.within(client,
// result): the caller's own work in the same transaction (the requests
// register records the erasure).
const personalData = () => require("../../../personal-data/services/personalDataRestaurant");
const eraseCustomer = async (restaurantId, id, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // The guest's bills and orders are locked before the guest, the order a
    // payment takes them in (the bill, its order, then the guest it earns
    // points for). Taken the other way round, a bill paid at the moment its
    // guest was erased deadlocked: one of the two failed with a server error.
    // Now the second simply waits for the first.
    await crmRepository.lockGuestBillsAndOrders(client, restaurantId, id);

    const [customer] = await crmRepository.lockCustomers(client, restaurantId, [id]);

    if (!customer) {
      throw new AppError(404, "Customer not found");
    }

    if (customer.erased_at) {
      throw new AppError(409, "This guest's details have already been erased");
    }

    const open = await personalData().guestOpenItems(client, restaurantId, id);

    if (open.length) {
      throw new AppError(409, `${customer.name}'s details cannot be erased yet. ${open.join(" ")}`, { reason: "erasure_blocked", open });
    }

    // A company guest's tax invoices keep the company and GSTIN they were
    // made out to (GST law keeps invoices for years, and the DPDP Act allows
    // what a law requires to be kept): billing wrote them on each bill when it
    // was raised, so erasing the record changes no invoice. Writing the
    // guest's GSTIN onto every bill here (as this once did) turned their
    // earlier ordinary bills into B2B invoices after they were issued.
    const points = Number(customer.loyalty_points) || 0;

    if (points > 0) {
      await loyaltyRepository.recordPoints(
        client,
        restaurantId,
        {
          customerId: id,
          points: -points,
          entryType: "expire",
          // The reason stays in the activity log only: it may name the guest.
          notes: "Cancelled: the guest's details were erased at their request",
        },
        userId
      );
    }

    // Their consents stop (kept as the record), before the guest's own row is erased.
    await personalData().onGuestErased(client, restaurantId, id, userId);

    // Copies of the name are cleared while everything is still linked, open
    // orders included; then what is still running is let go.
    const { customer: erased, cleared } = await crmRepository.eraseCustomer(
      client,
      restaurantId,
      customer,
      userId
    );
    const detached = await crmRepository.detachLiveRecords(client, restaurantId, id);
    const result = {
      customer: toCustomer(erased),
      formerName: customer.name,
      pointsCancelled: points,
      cleared,
      detached,
    };

    if (options.within) {
      await options.within(client, result);
    }

    await client.query("COMMIT");

    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// Two records of the same guest become one. Everything that points at the
// merged record (orders, feedback, complaints, points, bookings, anything
// else linked to a guest) moves to the kept one; points add up; the kept
// record fills its blanks from the merged one; the merged record is deleted.
// One transaction: it all happens or none of it does.
//
// The mobile clean-up's rows (what each record's number looked like before it
// was tidied) describe the record itself, not the guest's history, so they do
// not move: they go with the folded record. Carried across, the migration's
// rollback would have written the folded record's old spelling and notes over
// the guest that stayed.
// Consents, a child's mark, requests and breach rows are moved by their own
// module (personal-data), which keeps one consent per purpose.
const MERGE_SKIPS = new Set([
  "customer_mobile_cleanup",
  "business_consents",
  "business_children",
  "business_privacy_requests",
  "business_privacy_breach_people",
  "business_privacy_breach_notices",
]);

// What the guest who stays carries for GST invoices after a merge.
//
// Every B2B invoice either record holds carries its buyer on the bill (billing
// wrote it there), so moving it, or the record losing or changing its GSTIN,
// never changes it. The bills without a buyer are ordinary (B2C) sales.
//
// When the merged guest holds ordinary bills, the record that stays carries
// no GSTIN: its own (or the folded record's) is set aside, and a line in its
// notes says so, for whoever looks at the guest to decide. Otherwise it keeps
// its own, or takes the folded record's. (This was needed while the GST
// report read a guest's GSTIN for their bills without a buyer; the reports
// now read only the bill, so it is a caution, no longer a necessity.)
const mergedBusiness = (keep, merged, ordinaryBills) => {
  if (ordinaryBills === 0 || (!keep.gstin && !merged.gstin)) {
    return { business: null, setAside: null };
  }

  const holder = keep.gstin ? keep : merged;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  return {
    business: { companyName: keep.company_name || merged.company_name || null, gstin: null },
    setAside: { gstin: holder.gstin, companyName: holder.company_name || null, from: holder === keep ? "kept" : "merged" },
    note:
      `GSTIN ${holder.gstin}${holder.company_name ? ` (${holder.company_name})` : ""} set aside at the merge on ${today}: ` +
      "this record also holds ordinary bills, which must stay ordinary sales. Invoices already made out to it keep it.",
  };
};

const mergeCustomers = async (restaurantId, keepId, mergeId, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  const { reveal = true } = options;

  if (keepId === mergeId) {
    throw new AppError(400, "Pick two different guests to merge");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Both guests' bills and orders first, as an erase takes them (and a
    // payment): a bill paid while its guest is merged then waits instead of
    // deadlocking with the merge.
    await crmRepository.lockGuestBillsAndOrders(client, restaurantId, [keepId, mergeId]);

    const locked = await crmRepository.lockCustomers(client, restaurantId, [keepId, mergeId]);
    const keep = locked.find((row) => row.id === keepId);
    const merged = locked.find((row) => row.id === mergeId);

    if (!keep || !merged) {
      throw new AppError(404, "Customer not found");
    }

    if (keep.erased_at || merged.erased_at) {
      throw new AppError(400, "A guest whose details were erased cannot be merged");
    }

    const ordinaryBills = await crmRepository.countOrdinaryBills(client, restaurantId, [keep.id, merged.id]);
    const gst = mergedBusiness(keep, merged, ordinaryBills);

    const recordsMoved = {};
    await personalData().onGuestsMerged(client, restaurantId, merged.id, keep.id, userId);
    const references = await crmRepository.findGuestReferences(client);

    for (const reference of references) {
      if (MERGE_SKIPS.has(reference.table_name)) {
        continue;
      }

      const moved = await crmRepository.moveGuestReferences(
        client,
        restaurantId,
        reference,
        merged.id,
        keep.id
      );

      if (moved > 0) {
        const key = reference.table_name;
        recordsMoved[key] = (recordsMoved[key] || 0) + moved;
      }
    }

    const pointsMoved = Number(merged.loyalty_points) || 0;
    const kept = await crmRepository.absorbCustomer(client, restaurantId, keep, merged, userId, {
      business: gst.business,
      note: gst.note,
    });

    await crmRepository.recomputeLedger(client, restaurantId, keep.id, Number(kept.loyalty_points));
    await crmRepository.deleteMergedCustomer(client, restaurantId, merged.id);
    await crmRepository.recordMerge(
      client,
      restaurantId,
      {
        keptId: keep.id,
        mergedId: merged.id,
        mergedName: merged.name,
        mergedMobile: merged.mobile,
        pointsMoved,
        recordsMoved,
      },
      userId
    );

    await client.query("COMMIT");

    return {
      customer: toCustomer(kept, reveal),
      merged: {
        id: merged.id,
        name: merged.name,
        mobile: reveal ? merged.mobile : null,
        mobileMasked: merged.mobile ? maskMobile(merged.mobile) : null,
      },
      pointsMoved,
      recordsMoved,
      pointsBefore: { kept: Number(keep.loyalty_points) || 0, merged: pointsMoved },
      invoices: { ordinaryBills, gstinSetAside: gst.setAside },
    };
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === DUPLICATE) {
      throw new AppError(
        409,
        "These two records could not be merged because both hold something only one guest can have. Nothing was changed."
      );
    }

    throw error;
  } finally {
    client.release();
  }
};

const listDuplicates = async (restaurantId, reveal) => {
  requireRestaurantId(restaurantId);

  const rows = await crmRepository.findDuplicatePairs(restaurantId);

  return rows.map((row) => {
    // What was typed, from the clean-up; or the number the record holds now
    // (a "+" form with the same ten digits as the guest it is paired with).
    const typed = row.typed_mobile || row.mobile || null;

    return {
      duplicate: {
        id: row.id,
        name: row.name,
        typedMobile: typed ? (reveal ? typed : maskMobile(typed)) : null,
        email: reveal ? row.email : null,
        emailMasked: maskEmail(row.email),
        loyaltyPoints: row.loyalty_points,
        visits: Number(row.visits),
        lastVisit: row.last_visit,
        spend: round2(Number(row.spend)),
        createdAt: row.created_at,
        status: row.status,
        gstin: row.gstin ?? null,
        companyName: row.company_name ?? null,
      },
      keep: {
        id: row.keep_id,
        name: row.keep_name,
        mobileDisplay: row.keep_mobile ? (reveal ? formatMobile(row.keep_mobile) : maskMobile(row.keep_mobile)) : null,
        email: reveal ? row.keep_email : null,
        emailMasked: maskEmail(row.keep_email),
        loyaltyPoints: row.keep_points,
        visits: Number(row.keep_visits),
        lastVisit: row.keep_last_visit,
        spend: round2(Number(row.keep_spend)),
        createdAt: row.keep_created_at,
        status: row.keep_status,
        gstin: row.keep_gstin ?? null,
        companyName: row.keep_company_name ?? null,
      },
    };
  });
};

// "They are not the same person" (two people sharing one family phone).
const dismissDuplicate = async (restaurantId, id, userId) => {
  requireRestaurantId(restaurantId);

  const cleared = await crmRepository.clearDuplicateMark(restaurantId, id, userId);

  if (!cleared) {
    throw new AppError(404, "That guest is not marked as a possible duplicate");
  }
};

// Used by feedback and complaints: an existing customer's details are copied in
// so the record still reads correctly if the customer is later removed. A
// walk-in whose mobile is already in the guest book is linked to them.
const resolveCustomer = async (restaurantId, data) => {
  if (!data.customerId) {
    const known = data.customerMobile
      ? await crmRepository.findCustomerByMobile(restaurantId, data.customerMobile)
      : null;

    if (known && !known.erased_at) {
      return {
        customerId: known.id,
        customerName: data.customerName || known.name,
        customerMobile: data.customerMobile,
      };
    }

    return { customerId: null, customerName: data.customerName, customerMobile: data.customerMobile };
  }

  const customer = await crmRepository.findCustomerById(restaurantId, data.customerId);

  if (!customer) {
    throw new AppError(400, "Selected customer does not exist");
  }

  // Nothing new is attached to a guest who asked for their data to be
  // erased: a name and number saved against the record would put back what
  // they asked to have removed. (The screens' pickers leave erased guests
  // out; this is for a form opened before the erase, or the API.)
  if (customer.erased_at) {
    throw new AppError(
      409,
      "This guest's details were erased at their request, so nothing new can be saved against their record. Save it without picking a guest.",
      { reason: "erased" }
    );
  }

  return {
    customerId: customer.id,
    customerName: data.customerName || customer.name,
    customerMobile: data.customerMobile || customer.mobile,
  };
};

// A bill's guest, to name on a complaint about that bill: nobody when the
// guest's details were erased (the complaint keeps the bill link only).
const linkedGuestId = async (restaurantId, customerId) => {
  if (!customerId) {
    return null;
  }

  const guest = await crmRepository.findCustomerById(restaurantId, customerId);

  return guest && !guest.erased_at ? guest.id : null;
};

// --- Feedback ---

const listFeedback = async (restaurantId, filters = {}, reveal = true) => {
  requireRestaurantId(restaurantId);

  const limit = filters.limit || 200;
  const offset = filters.offset || 0;
  const terms = readSearch(filters.search, reveal);

  const [page, summary] = await Promise.all([
    crmRepository.findFeedbackPage(restaurantId, {
      status: filters.status || null,
      rating: filters.rating || null,
      ...terms,
      limit,
      offset,
    }),
    crmRepository.feedbackSummary(restaurantId),
  ]);

  return {
    summary: {
      total: summary.total,
      average: Number(summary.average),
      happy: summary.happy,
      unhappy: summary.unhappy,
      unread: summary.unread,
    },
    ...pageOf(page, limit, offset, (row) => toFeedback(row, reveal)),
    searchLimited: Boolean(terms.limited),
  };
};

// Answers with the first page of feedback (as it always has) and the row just
// saved, both masked the way the person saving would see them in the list:
// saving a comment must not hand back other guests' numbers.
const createFeedback = async (restaurantId, data, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  const { reveal = true } = options;
  const tidy = { ...data, customerMobile: readMobile(data.customerMobile, "Customer mobile") };
  const customer = await resolveCustomer(restaurantId, tidy);
  const id = await crmRepository.createFeedback(restaurantId, { ...tidy, ...customer }, userId);
  const [list, created] = await Promise.all([
    listFeedback(restaurantId, { limit: 25 }, reveal),
    crmRepository.findFeedbackById(restaurantId, id),
  ]);

  return { ...list, created: created ? toFeedback(created, reveal) : null };
};

const setFeedbackStatus = async (restaurantId, id, status, userId) => {
  requireRestaurantId(restaurantId);

  const updated = await crmRepository.updateFeedbackStatus(restaurantId, id, status, userId);

  if (!updated) {
    throw new AppError(404, "Feedback not found");
  }
};

// --- Complaints ---

const listComplaints = async (restaurantId, filters = {}, reveal = true) => {
  requireRestaurantId(restaurantId);

  const limit = filters.limit || 200;
  const offset = filters.offset || 0;
  const context = await crmRepository.findReportContext(restaurantId);
  const terms = readSearch(filters.search, reveal);

  const [page, summary, costs] = await Promise.all([
    crmRepository.findComplaintsPage(restaurantId, {
      status: filters.status || null,
      outletId: filters.outletId || null,
      oldestFirst: Boolean(filters.oldestFirst),
      ...terms,
      limit,
      offset,
    }),
    crmRepository.complaintSummary(restaurantId),
    crmRepository.complaintCosts(restaurantId, context ? context.timezone : "Asia/Kolkata"),
  ]);

  return {
    summary: {
      ...summary,
      compensationMonth: round2(Number(costs.compensation_month)),
      compensationTotal: round2(Number(costs.compensation_total)),
      compensated: costs.compensated,
      linked: costs.linked,
      hoursToResolve: costs.hours_to_resolve === null ? null : Number(costs.hours_to_resolve),
    },
    ...pageOf(page, limit, offset, (row) => toComplaint(row, reveal)),
    searchLimited: Boolean(terms.limited),
  };
};

const listAssignees = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await crmRepository.findAssignees(restaurantId);

  return rows.map((row) => ({ id: row.id, name: row.name, roles: row.roles || "" }));
};

// A complaint can only be handed to this restaurant's own staff. Keeping the
// person it is already with is always allowed, even if they have since left,
// so editing an old complaint does not force a reassignment.
const checkAssignee = async (restaurantId, assignedTo, current = null) => {
  if (!assignedTo || assignedTo === current) {
    return;
  }

  const person = await crmRepository.findAssignee(restaurantId, assignedTo);

  if (!person) {
    throw new AppError(400, "Pick someone from your own staff list to handle this complaint");
  }

  if (person.status !== "active") {
    throw new AppError(400, `${person.name} is no longer active. Pick someone who is working now.`);
  }
};

// reveal: as for any read (canSeeContacts), so a bill number typed on the
// complaint form never hands back its guest's full mobile, whether it matched
// one bill or several.
const toMatch = (row, reveal = true) => ({
  billId: row.bill_id || row.latest_bill_id || null,
  billNumber: row.bill_number || row.latest_bill_number || null,
  orderId: row.order_id,
  orderNumber: row.order_number,
  orderType: row.order_type,
  orderStatus: row.order_status,
  billStatus: row.bill_status || null,
  total: round2(Number(row.total_amount || 0)),
  at: row.billed_at || row.placed_at,
  customerId: row.customer_id || null,
  guestName: row.guest_name || null,
  guestMobile: maskedContact(row.guest_mobile || null, reveal),
});

// Finds the bill or order a complaint is about, from the number the guest
// reads off their bill. A bill number is tried first, then an order number.
const findReference = async (restaurantId, text, reveal = true) => {
  const typed = String(text).trim();
  let rows = await crmRepository.findBillsByNumber(restaurantId, typed);
  let kind = "bill";

  if (rows.length === 0) {
    rows = await crmRepository.findOrdersByNumber(restaurantId, typed);
    kind = "order";
  }

  if (rows.length === 0) {
    throw new AppError(
      400,
      `No bill or order numbered “${typed}” in this restaurant. Check the number printed on the bill.`
    );
  }

  if (rows.length > 1) {
    const numbers = rows.slice(0, 3).map((row) => row.bill_number || row.order_number);
    throw new AppError(
      400,
      `More than one ${kind} matches “${typed}” (${numbers.join(", ")}). Type the full number.`,
      { matches: rows.map((row) => toMatch(row, reveal)) }
    );
  }

  return toMatch(rows[0], reveal);
};

const lookupReference = async (restaurantId, text, reveal) => {
  requireRestaurantId(restaurantId);

  return findReference(restaurantId, text, reveal);
};

// Reads the link a complaint should carry: a number typed from the bill, or
// the ids a screen already has. Returns undefined when the request says
// nothing about it (an edit that leaves the link alone).
const resolveLink = async (restaurantId, data, reveal = true) => {
  if (data.reference !== undefined) {
    if (!data.reference) {
      return { billId: null, orderId: null, customerId: null };
    }

    const match = await findReference(restaurantId, data.reference, reveal);

    return { billId: match.billId, orderId: match.orderId, customerId: match.customerId };
  }

  if (data.billId) {
    const bill = await crmRepository.findBillLink(restaurantId, data.billId);

    if (!bill) {
      throw new AppError(400, "That bill is not in this restaurant");
    }

    return { billId: bill.bill_id, orderId: bill.order_id, customerId: bill.customer_id };
  }

  if (data.orderId) {
    const order = await crmRepository.findOrderLink(restaurantId, data.orderId);

    if (!order) {
      throw new AppError(400, "That order is not in this restaurant");
    }

    return { billId: null, orderId: order.order_id, customerId: order.customer_id };
  }

  if (data.billId === null || data.orderId === null) {
    return { billId: null, orderId: null, customerId: null };
  }

  return undefined;
};

// What was given to put a complaint right must say what it was, and an
// apology costs nothing.
const checkCompensation = (data) => {
  if (data.compensationType === undefined && data.compensationValue === undefined) {
    return;
  }

  const value = Number(data.compensationValue || 0);

  if (!data.compensationType && value > 0) {
    throw new AppError(400, "Say what the guest was given for that amount (a dish replaced, a refund, a voucher…)");
  }

  if (data.compensationType === "apology" && value > 0) {
    throw new AppError(400, "An apology has no cost. Pick what was given if it cost the restaurant something.");
  }
};

// options.reveal: whether the answer may show the guest's full mobile. A
// complaint typed against a bill number links that bill's guest, and the
// person logging it must not learn the guest's number that way.
const createComplaint = async (restaurantId, data, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  const { reveal = true } = options;
  const tidy = { ...data, customerMobile: readMobile(data.customerMobile, "Customer mobile") };

  await checkAssignee(restaurantId, tidy.assignedTo);
  checkCompensation(tidy);

  const link = await resolveLink(restaurantId, tidy, reveal);

  // A complaint about a bill whose order carried a guest is that guest's,
  // unless the screen picked someone else (and unless that guest's details
  // were erased: the complaint then carries the bill only).
  if (link && !tidy.customerId && link.customerId) {
    tidy.customerId = await linkedGuestId(restaurantId, link.customerId);
  }

  const customer = await resolveCustomer(restaurantId, tidy);
  const id = await crmRepository.createComplaint(
    restaurantId,
    {
      ...tidy,
      ...customer,
      billId: link ? link.billId : null,
      orderId: link ? link.orderId : null,
      compensationValue: tidy.compensationValue === undefined ? 0 : round2(Number(tidy.compensationValue || 0)),
    },
    userId
  );

  return toComplaint(await crmRepository.findComplaintById(restaurantId, id), reveal);
};

// An edit, with the complaint as it was, so the controller can log a change
// in what the guest was given. options.reveal as for createComplaint.
const editComplaint = async (restaurantId, id, data, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  const { reveal = true } = options;

  // A complaint cannot be closed without saying how it was resolved.
  if (["resolved", "closed"].includes(data.complaintStatus) && !data.resolution) {
    throw new AppError(400, "Write how the complaint was resolved");
  }

  const existing = await crmRepository.findComplaintById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Complaint not found");
  }

  await checkAssignee(restaurantId, data.assignedTo, existing.assigned_to);
  checkCompensation(data);

  const changes = { ...data };

  if (data.customerMobile !== undefined) {
    changes.customerMobile = readMobile(data.customerMobile, "Customer mobile");
  }

  const link = await resolveLink(restaurantId, data, reveal);

  if (link) {
    changes.billId = link.billId;
    changes.orderId = link.orderId;

    // Linking a bill to a complaint nobody had put a guest on names the guest.
    if (!existing.customer_id && link.customerId) {
      const guest = await crmRepository.findCustomerById(restaurantId, link.customerId);

      if (guest && !guest.erased_at) {
        changes.customerId = guest.id;
        changes.customerName = existing.customer_name || guest.name;
        changes.customerMobile = changes.customerMobile ?? existing.customer_mobile ?? guest.mobile;
      }
    }
  }

  if (data.compensationValue !== undefined) {
    changes.compensationValue = round2(Number(data.compensationValue || 0));
  }

  const updated = await crmRepository.updateComplaint(restaurantId, id, changes, userId);

  if (!updated) {
    throw new AppError(404, "Complaint not found");
  }

  return {
    before: toComplaint(existing),
    after: toComplaint(await crmRepository.findComplaintById(restaurantId, id), reveal),
  };
};

// A customer's visit history: what they spent, how often, and what they like.
const customerHistory = async (restaurantId, customerId, options = {}) => {
  requireRestaurantId(restaurantId);

  const { reveal = true, visitsLimit = 50, visitsOffset = 0 } = options;
  const customer = await crmRepository.findCustomerById(restaurantId, customerId);

  if (!customer) {
    throw new AppError(404, "Customer not found");
  }

  const [visits, totals, favourites, points, merges] = await Promise.all([
    crmRepository.findVisitsForCustomer(restaurantId, customerId, {
      limit: visitsLimit,
      offset: visitsOffset,
    }),
    crmRepository.customerTotals(restaurantId, customerId),
    loyaltyRepository.favouriteItems(restaurantId, customerId),
    loyaltyRepository.findForCustomer(restaurantId, customerId, 50),
    crmRepository.findMergesInto(restaurantId, customerId),
  ]);

  const totalSpent = round2(Number(totals.total_spent));

  return {
    customer: toCustomer(customer, reveal),
    summary: {
      visits: totals.visits,
      cancelled: totals.cancelled,
      billedVisits: totals.billed_visits,
      totalSpent,
      // Per visit, not per bill: a visit paid on two bills is one visit.
      averageSpend: totals.billed_visits > 0 ? round2(totalSpent / totals.billed_visits) : 0,
      lastVisit: totals.last_visit,
      firstVisit: totals.first_visit,
    },
    ordersTotal: visits.length ? visits[0].total_count : 0,
    ordersOffset: visitsOffset,
    orders: visits.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      orderType: row.order_type,
      placedAt: row.placed_at,
      orderStatus: row.order_status,
      cancelled: row.order_status === "cancelled",
      orderTotal: Number(row.order_total),
      billNumber: row.bill_numbers && row.bill_numbers.length ? row.bill_numbers.join(", ") : null,
      billNumbers: row.bill_numbers || [],
      billCount: row.bill_count || 0,
      billTotal: row.bill_total === null ? null : round2(Number(row.bill_total)),
      itemCount: row.item_count || 0,
      items: row.items,
    })),
    favourites: favourites.map((row) => ({
      itemName: row.item_name,
      quantity: Number(row.quantity),
    })),
    loyalty: points.map((row) => ({
      id: row.id,
      points: row.points,
      balanceAfter: row.balance_after,
      entryType: row.entry_type,
      amount: row.amount === null ? null : Number(row.amount),
      notes: row.notes,
      billNumber: row.bill_number,
      createdAt: row.created_at,
      createdByName: row.created_by_name || null,
    })),
    merges: merges.map((row) => ({
      id: row.id,
      mergedName: row.merged_name,
      mergedMobile: row.merged_mobile ? (reveal ? formatMobile(row.merged_mobile) : maskMobile(row.merged_mobile)) : null,
      pointsMoved: row.points_moved,
      recordsMoved: row.records_moved || {},
      mergedAt: row.created_at,
      mergedBy: row.merged_by_name,
    })),
  };
};

// A manual points correction, for goodwill or to fix a mistake.
const adjustPoints = async (restaurantId, customerId, points, notes, userId) => {
  requireRestaurantId(restaurantId);

  const customer = await crmRepository.findCustomerById(restaurantId, customerId);

  if (!customer) {
    throw new AppError(404, "Customer not found");
  }

  if (customer.erased_at) {
    throw new AppError(409, "This guest's details were erased, so their points can no longer change");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const balance = await loyaltyRepository.recordPoints(
      client,
      restaurantId,
      { customerId, points, entryType: "adjust", notes },
      userId
    );

    await client.query("COMMIT");
    return { customerId, balance };
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "NOT_ENOUGH_POINTS") {
      throw new AppError(400, `That customer has only ${error.balance} points`);
    }

    throw error;
  } finally {
    client.release();
  }
};

// --- Opening one guest's number on purpose ---

// A cashier who does not see guests' numbers sometimes needs one: calling a
// guest back about a phone left on the table, or an order that is ready.
// They can open one guest's contact details at a time; each opening is on the
// activity log (written by the controller before it answers), and after this
// many different guests in a day the rest need a manager. Nobody copies the
// guest book one guest at a time without it showing.
const CONTACT_VIEWS_PER_DAY = 20;

// The count and the activity-log row are one transaction under a lock per
// person: forty requests sent at once are decided one after another, so the
// twenty-first different guest is refused however the requests arrive.
// options.limited: false for someone who sees every number anyway (not
// counted, not logged). options.userName: for the log row.
const revealContact = async (restaurantId, customerId, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  const { limited = true, userName = null } = options;
  const customer = await crmRepository.findCustomerById(restaurantId, customerId);

  if (!customer) {
    throw new AppError(404, "Customer not found");
  }

  if (customer.erased_at) {
    throw new AppError(409, "This guest's details were erased at their request, so there is nothing to show");
  }

  if (limited) {
    await inTransaction(async (client) => {
      await crmRepository.lockContactViews(client, restaurantId, userId);
      const today = await crmRepository.contactViewsToday(client, restaurantId, userId, customer.id);

      if (!today.seen && today.guests >= CONTACT_VIEWS_PER_DAY) {
        throw new AppError(
          429,
          `You have opened ${CONTACT_VIEWS_PER_DAY} guests' contact details in the last 24 hours. Ask a manager to look this one up.`,
          { reason: "contact_limit", limit: CONTACT_VIEWS_PER_DAY }
        );
      }

      await crmRepository.recordContactView(client, {
        restaurantId,
        userId,
        userName,
        customerId: customer.id,
        label: customer.name,
      });
    });
  }

  return {
    id: customer.id,
    name: customer.name,
    mobile: customer.mobile,
    mobileDisplay: customer.mobile ? formatMobile(customer.mobile) : null,
    email: customer.email,
    address: customer.address,
    limit: CONTACT_VIEWS_PER_DAY,
  };
};

// --- Reports ---

const reportContext = async (restaurantId) => {
  const context = await crmRepository.findReportContext(restaurantId);

  if (!context) {
    throw new AppError(404, "Restaurant not found");
  }

  return context;
};

// Points: what the restaurant owes its guests now (in points and in rupees),
// and how points moved day by day in the period.
const loyaltyReport = async (restaurantId, { from, to, limit = 25, offset = 0 }, reveal) => {
  requireRestaurantId(restaurantId);

  const context = await reportContext(restaurantId);
  const pointValue = Number(context.loyalty_point_value);

  const [owed, totals, byDay, holders] = await Promise.all([
    crmRepository.pointsOwed(restaurantId),
    crmRepository.loyaltyTotals(restaurantId, context.timezone, from, to),
    crmRepository.loyaltyByDay(restaurantId, context.timezone, from, to),
    crmRepository.findPointHolders(restaurantId, { limit, offset }),
  ]);

  const kind = (key) => totals.find((row) => row.kind === key) || { points: 0, amount: 0, bills: 0, entries: 0 };
  const redeemed = kind("redeemed");

  return {
    from,
    to,
    currency: context.currency_symbol,
    loyaltyEnabled: context.loyalty_enabled,
    pointValue,
    earnAmount: Number(context.loyalty_earn_amount),
    owed: {
      points: owed.points,
      value: round2(owed.points * pointValue),
      guests: owed.guests,
    },
    period: {
      earned: kind("earned").points,
      redeemed: -redeemed.points,
      redeemedValue: round2(Number(redeemed.amount)),
      redeemedBills: redeemed.bills,
      returned: kind("returned").points,
      manual: kind("manual").points,
      manualEntries: kind("manual").entries,
      // Balances brought over by the guest import, apart from points given
      // by hand, so the period still adds up to what is owed.
      opening: kind("opening").points,
      openingGuests: kind("opening").entries,
      expired: -kind("expired").points,
      net: totals.reduce((sum, row) => sum + row.points, 0),
    },
    byDay: byDay.map((row) => ({
      date: row.day,
      earned: row.earned,
      redeemed: row.redeemed,
      redeemedValue: round2(Number(row.redeemed_value)),
      redeemedBills: row.redeemed_bills,
      other: row.other,
    })),
    holders: {
      items: holders.rows.map((row) => ({
        id: row.id,
        name: row.name,
        mobileDisplay: row.mobile ? (reveal ? formatMobile(row.mobile) : maskMobile(row.mobile)) : null,
        mobile: reveal ? row.mobile : null,
        tags: row.tags || [],
        points: row.loyalty_points,
        value: round2(row.loyalty_points * pointValue),
        lastVisit: row.last_visit,
      })),
      total: holders.total,
      limit,
      offset,
    },
  };
};

// Sales by guest in the period, and what share of all sales the guest book
// accounts for.
const customerSalesReport = async (restaurantId, filters, reveal) => {
  requireRestaurantId(restaurantId);

  const context = await reportContext(restaurantId);
  const { from, to, limit = 25, offset = 0, sort = "spend", ascending = false } = filters;
  const terms = readSearch(filters.search, reveal);

  const [page, split] = await Promise.all([
    crmRepository.customerSales(restaurantId, context.timezone, from, to, {
      sort,
      ascending,
      limit,
      offset,
      ...terms,
    }),
    crmRepository.salesSplit(restaurantId, context.timezone, from, to),
  ]);

  const sales = round2(Number(split.sales));
  const guestSales = round2(Number(split.guest_sales));

  return {
    from,
    to,
    currency: context.currency_symbol,
    totals: {
      bills: split.bills,
      sales,
      guestBills: split.guest_bills,
      guestSales,
      guests: split.guests,
      walkInBills: split.bills - split.guest_bills,
      walkInSales: round2(sales - guestSales),
      guestShare: sales > 0 ? round2((guestSales / sales) * 100) : 0,
    },
    items: page.rows.map((row) => {
      const spend = round2(Number(row.spend));

      return {
        id: row.id,
        name: row.name,
        erased: Boolean(row.erased_at),
        mobileDisplay: row.mobile ? (reveal ? formatMobile(row.mobile) : maskMobile(row.mobile)) : null,
        mobile: reveal ? row.mobile : null,
        tags: row.tags || [],
        companyName: row.company_name,
        gstin: row.gstin,
        visits: row.visits,
        bills: row.bills,
        spend,
        average: row.visits > 0 ? round2(spend / row.visits) : 0,
        discounts: round2(Number(row.discounts)),
        pointsValue: round2(Number(row.points_value)),
        lastVisit: row.last_bill,
      };
    }),
    total: page.total,
    limit,
    offset,
    searchLimited: Boolean(terms.limited),
  };
};

const todayFor = async (restaurantId) => (await reportContext(restaurantId)).today;

module.exports = {
  customerHistory,
  adjustPoints,
  revealContact,
  listCustomers,
  listGuestBook,
  exportGuestBook,
  createCustomer,
  editCustomer,
  removeCustomer,
  eraseCustomer,
  mergeCustomers,
  listDuplicates,
  dismissDuplicate,
  listFeedback,
  createFeedback,
  setFeedbackStatus,
  listComplaints,
  listAssignees,
  lookupReference,
  createComplaint,
  editComplaint,
  loyaltyReport,
  customerSalesReport,
  todayFor,
  maskEmail,
  panChangeOf,
};
