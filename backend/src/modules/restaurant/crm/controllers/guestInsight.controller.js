const guestInsightService = require("../services/guestInsight.service");
const AppError = require("../../../../utils/AppError");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");

// The restaurant is always the one on the token. Nothing in the path, the
// query string or the body can point these reads at another restaurant.

const readSegmentKey = (value) => v.requiredString(value, "Guest list", 40).toLowerCase();

// Full mobiles and emails are for customers.contact (owners and managers), as
// in the guest book; everyone else who may see guests reads them masked.
const canSeeContacts = (req) => (req.user?.permissions || []).includes("customers.contact");

// The whole picture for the Guest insights screen.
const summary = async (req, res) => {
  res.json({
    success: true,
    data: await guestInsightService.summary(req.user.restaurantId, new Date(), { reveal: canSeeContacts(req) }),
  });
};

// One segment's guests, searchable, in the order worth reading them.
const segment = async (req, res) => {
  const filters = {
    search: v.optionalString(req.query.search, "Search", 100),
    limit:
      v.optionalNumber(req.query.limit, "Limit", { min: 1, max: guestInsightService.MAX_LIMIT }) ??
      guestInsightService.DEFAULT_LIMIT,
  };

  filters.limit = Math.floor(filters.limit);

  res.json({
    success: true,
    data: await guestInsightService.segmentList(req.user.restaurantId, readSegmentKey(req.params.key), {
      ...filters,
      reveal: canSeeContacts(req),
    }),
  });
};

// A segment for a campaign: a CSV to open in Excel, or the mobile numbers to
// paste into a WhatsApp broadcast or an SMS tool — the guests the screen is
// showing, so a search typed in the box narrows the export too. This is
// personal data leaving the system, so it is a POST (it has an effect — the
// log entry) and every one is written to the activity log with how many
// guests it held and what was searched.
//
// The contact columns follow the guest book's export: full for those who may
// see guests' contact details (customers.contact), masked for anyone else who
// may export. The mobile list for a broadcast is nothing but numbers, so it
// needs that right outright.
const exportSegment = async (req, res) => {
  const key = readSegmentKey(req.params.key);
  const format = v.optionalEnum(req.body?.format, "Format", ["csv", "mobiles"], "csv");
  const search = v.optionalString(req.body?.search, "Search", 100);
  const reveal = canSeeContacts(req);

  if (format === "mobiles" && !reveal) {
    throw new AppError(
      403,
      "Copying guests' mobile numbers needs the right to see guest contact details. You can still export this list as a CSV, with each mobile shown by its last 4 digits — or ask the owner or a manager to copy the numbers."
    );
  }

  // Numbers for a broadcast are for offers: only the guests who agreed to them.
  const result = await guestInsightService.segmentExport(req.user.restaurantId, key, { search, reveal, forOffers: format === "mobiles" });

  // Awaited, unlike most log entries: the record of who took the list is
  // written before the list leaves. Writing it never throws, so a logging
  // hiccup still cannot block the export.
  await logAction(req, "export", "guest_list", {
    label: `${result.segment.label} · ${result.total} ${result.total === 1 ? "guest" : "guests"}${
      result.search ? ` matching “${result.search}”` : ""
    }`,
    details: {
      list: result.segment.key,
      format,
      search: result.search,
      guests: result.total,
      mobiles: result.withMobile,
      leftOut: result.leftOut || undefined,
      ...(reveal ? {} : { contacts: "masked" }),
    },
  });

  res.json({ success: true, data: { ...result, format } });
};

// One guest by id, for a link from the bell or another screen. Always 200: an
// empty list means "not in your guest book", which the screen says in words.
const guest = async (req, res) => {
  const raw = String(req.query.id ?? "").trim();
  const id = Number(raw);

  // Checked here rather than with requiredId, whose range message would read
  // "between 1 and Infinity" for a 0.
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id < 1) {
    throw new AppError(400, "Guest must be a guest's id number, such as ?id=42 — check the link you followed");
  }

  res.json({
    success: true,
    data: await guestInsightService.findGuest(req.user.restaurantId, id, { reveal: canSeeContacts(req) }),
  });
};

module.exports = {
  summary,
  segment,
  exportSegment,
  guest,
};
