const auditRepository = require("../repositories/audit.repository");
const timeclockRepository = require("../../restaurant/staff/repositories/timeclock.repository");
const { zonedInstant, addDays, safeZone } = require("../../restaurant/staff/services/timeclock.service");
const AppError = require("../../../utils/AppError");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// A real calendar day: "2026-02-30" has the right shape but is no date, and
// JavaScript would quietly read it as 2 March.
const isRealDate = (value) => {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toEntry = (row) => ({
  id: row.id,
  userId: row.user_id,
  userName: row.user_name,
  action: row.action,
  entityType: row.entity_type,
  entityId: row.entity_id,
  entityLabel: row.entity_label,
  details: row.details,
  approvedById: row.approved_by,
  approverName: row.approver_name,
  sensitive: Boolean(row.sensitive),
  createdAt: row.created_at,
});

// Dates are the restaurant's own calendar days: "the 21st" runs from midnight
// to midnight in its timezone, whatever clock the server keeps.
const boundFilters = async (restaurantId, filters) => {
  requireRestaurantId(restaurantId);

  for (const [field, value] of [["From", filters.from], ["To", filters.to]]) {
    if (value && !isRealDate(value)) {
      throw new AppError(400, `${field} must be a date like 2026-09-24`);
    }
  }

  if (filters.from && filters.to && filters.to < filters.from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  const timezone = safeZone(await timeclockRepository.findTimezone(restaurantId));

  return {
    timezone,
    bounded: {
      ...filters,
      fromInstant: filters.from ? zonedInstant(filters.from, "00:00", timezone) : null,
      toInstant: filters.to ? zonedInstant(addDays(filters.to, 1), "00:00", timezone) : null,
    },
  };
};

// Pay amounts are left out unless filters.seesSalaries (see audit.repository).
const search = async (restaurantId, filters) => {
  const { timezone, bounded } = await boundFilters(restaurantId, filters);
  const [{ rows, total }, counts] = await Promise.all([
    auditRepository.search(restaurantId, bounded),
    auditRepository.summary(restaurantId, bounded),
  ]);

  return {
    items: rows.map(toEntry),
    total,
    // For the same dates and person, whatever the other filters: the figures
    // an owner looks at before reading a single row.
    summary: counts,
    limit: filters.limit,
    offset: filters.offset,
    timezone,
  };
};

// --- Export ---
//
// Every row the filters match goes into the file: an owner exporting a month
// to check for theft must get the month, not its newest 5,000 rows. The
// screen reads it page by page (EXPORT_PAGE rows each, newest first); the
// first page also says how many there are, so the screen can show progress
// and check it received them all. A range too big for one spreadsheet file
// is refused up front with a narrower range to try, never cut short.
const EXPORT_PAGE = 2000;
const EXPORT_MAX_ROWS = 200000;

const exportPage = async (restaurantId, filters) => {
  const { timezone, bounded } = await boundFilters(restaurantId, filters);
  let total = null;

  if (!filters.cursor) {
    total = await auditRepository.countMatching(restaurantId, bounded);

    if (total > EXPORT_MAX_ROWS) {
      throw new AppError(
        400,
        `These filters match ${total.toLocaleString("en-IN")} entries, more than one export can hold (${EXPORT_MAX_ROWS.toLocaleString("en-IN")}). Pick a shorter date range, one person or one area, and export it in parts.`,
        { reason: "too_many_rows", total, max: EXPORT_MAX_ROWS }
      );
    }
  }

  const rows = await auditRepository.exportPage(restaurantId, bounded, {
    beforeId: filters.cursor || null,
    limit: EXPORT_PAGE,
  });

  return {
    items: rows.map(toEntry),
    total,
    // Where the next page starts, or null when this was the last.
    nextCursor: rows.length === EXPORT_PAGE ? rows[rows.length - 1].id : null,
    pageSize: EXPORT_PAGE,
    maxRows: EXPORT_MAX_ROWS,
    timezone,
  };
};

const facets = async (restaurantId) => {
  requireRestaurantId(restaurantId);
  return auditRepository.facets(restaurantId);
};

// People for the activity log's "Staff member" search.
const people = async (restaurantId, q, limit = 20) => {
  requireRestaurantId(restaurantId);
  return auditRepository.findPeople(restaurantId, q, limit);
};

module.exports = { search, exportPage, facets, people };
