const repo = require("../repositories/tasks.repository");
const templates = require("./templates.service");
const people = require("./people.service");
const { fail, id, v, category, dateText, timeText, addDays, dayOfWeek, daysBetween, lastDayOfMonth, localToday, PRIORITIES, FREQUENCIES } = require("./common");

// Recurring tasks: a schedule says what, who, where and how often; the
// occurrences are ordinary tasks made from it.
//
// Generation is lazy and idempotent. Every screen that lists tasks first
// calls ensure(scope): for each active schedule it makes the occurrences from
// the day after `generated_through` (at most BACKFILL_DAYS back) up to
// AHEAD_DAYS ahead, under a per-business advisory lock, with a unique index
// on (schedule, day, slot) as the last word — two screens asking at once, or
// a crash half-way, never make a task twice. Then the sweep marks missed
// every task whose window closed before it was done. No background job.

const BACKFILL_DAYS = 31;
const AHEAD_DAYS = 7;
// A due time before this belongs to the trading day before (a 01:00 closing
// check). The default; each restaurant (Settings) and business (Business
// settings › Rules) sets its own hour.
const DAY_CUTOFF = "05:00";
async function dayCutoff(db, scope) {
  const row = scope.world === "restaurant"
    ? await repo.one(db, "SELECT day_cutoff_hour AS h FROM restaurant_settings WHERE restaurant_id = $1", [scope.restaurantId])
    : await repo.one(db, "SELECT day_cutoff_hour AS h FROM business_settings WHERE business_id = $1", [scope.businessId]);
  return row && row.h !== null && row.h !== undefined ? `${String(row.h).padStart(2, "0")}:00` : DAY_CUTOFF;
}
const LOCK_KEY = 72017; // pg_advisory_xact_lock(LOCK_KEY, business id)

// Does a schedule fall on this calendar day?
function fallsOn(s, day) {
  if (day < s.starts_on || (s.ends_on && day > s.ends_on)) return false;
  switch (s.frequency) {
    case "daily":
    case "per_shift":
      return true;
    case "weekdays":
    case "weekly":
      return (s.weekdays || []).map(Number).includes(dayOfWeek(day));
    case "monthly":
      return Number(day.slice(8, 10)) === Math.min(Number(s.month_day), lastDayOfMonth(day));
    case "every_n_days":
      return daysBetween(s.starts_on, day) % Number(s.every_n) === 0;
    default:
      return false;
  }
}

// The occurrences of one day: [{ slot, due (local "YYYY-MM-DD HH:MM"), opens, closes, label }].
// Local times are turned into moments by the database, in the business's zone.
function slotsOn(s, day, shifts, cutoff = DAY_CUTOFF) {
  const at = (d, time) => `${d} ${time}`;
  const nightAware = (time) => (time < cutoff ? addDays(day, 1) : day);
  const dayEnd = at(addDays(day, 1), cutoff);
  const dayStart = at(day, cutoff);
  if (s.frequency === "per_shift" && shifts) {
    return shifts.map((shift, index) => {
      const start = shift.start.slice(0, 5), end = shift.end.slice(0, 5);
      const startDay = nightAware(start);
      const endDay = end <= start ? addDays(startDay, 1) : startDay;
      return { slot: index, opens: at(startDay, start), due: at(endDay, end), closesAfterMinutes: 60, label: `${shift.name} (${start}–${end})` };
    });
  }
  const times = [...(s.due_times || ["18:00"])].map((t) => String(t).slice(0, 5)).sort((a, b) => (nightAware(a) + a).localeCompare(nightAware(b) + b));
  return times.map((time, index) => {
    const due = at(nightAware(time), time);
    const next = times[index + 1];
    return {
      slot: index,
      opens: s.window_minutes ? null : dayStart,
      opensBeforeMinutes: s.window_minutes ? Number(s.window_minutes) : null,
      due,
      // Several times a day: each closes when the next one is due; the last at the end of the day.
      closes: next ? at(nightAware(next), next) : dayEnd,
      label: times.length > 1 ? `${time}` : null,
    };
  });
}

// The shifts a per-shift schedule follows (restaurant only).
async function shiftsFor(db, scope, s) {
  if (scope.world !== "restaurant") {
    return (s.due_times || []).map((t, i) => ({ id: i, name: `Shift ${i + 1}`, start: String(t).slice(0, 5), end: String(t).slice(0, 5) }));
  }
  const rows = await repo.all(db, `SELECT id, name, start_time::text AS start, end_time::text AS end FROM shifts
    WHERE restaurant_id = $1 AND status = 'active' AND ($2::bigint IS NULL OR id = $2) AND ($3::bigint IS NULL OR outlet_id IS NULL OR outlet_id = $3)
    ORDER BY start_time, id`, [scope.restaurantId, s.shift_id, s.outlet_id]);
  return rows;
}

async function generateSchedule(db, scope, s, today) {
  const from = [s.starts_on, s.generated_through ? addDays(s.generated_through, 1) : s.starts_on, addDays(today, -BACKFILL_DAYS)].sort().pop();
  let to = addDays(today, AHEAD_DAYS);
  if (s.ends_on && s.ends_on < to) to = s.ends_on;
  if (from > to) return 0;
  const source = await templates.resolve(db, scope, { templateId: s.template_id, libraryCode: s.library_code, allowArchived: true }).catch(() => null);
  const items = source ? source.items : [];
  const assignees = await repo.all(db, "SELECT kind, user_id, employee_id, resource_id, role_id, business_role_id FROM business_task_assignees WHERE business_id = $1 AND schedule_id = $2",
    [scope.businessId, s.id]);
  const shifts = s.frequency === "per_shift" ? await shiftsFor(db, scope, s) : null;
  const cutoff = await dayCutoff(db, scope);
  let made = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (!fallsOn(s, day)) continue;
    for (const slot of slotsOn(s, day, shifts, cutoff)) {
      const task = await repo.one(db, `INSERT INTO business_tasks (business_id, title, description, category_code, priority, location_id, outlet_id, assign_mode,
          opens_at, due_at, closes_at, schedule_id, occurrence_date, occurrence_slot, shift_label, template_id, library_code, requires_review, created_by)
        SELECT $1, $2, $3, $4, $5, $6, $7, $8,
          CASE WHEN $9::text IS NOT NULL THEN ($9::timestamp AT TIME ZONE $20) ELSE ($11::timestamp AT TIME ZONE $20) - make_interval(mins => $10::int) END,
          ($11::timestamp AT TIME ZONE $20),
          CASE WHEN $12::text IS NOT NULL THEN ($12::timestamp AT TIME ZONE $20) ELSE ($11::timestamp AT TIME ZONE $20) + make_interval(mins => $13::int) END,
          $14, $15, $16, $17, $18, $19, $21, NULL
        ON CONFLICT (business_id, schedule_id, occurrence_date, occurrence_slot) WHERE schedule_id IS NOT NULL DO NOTHING
        RETURNING id`,
      [scope.businessId, s.title, s.description, s.category_code, s.priority, s.location_id, s.outlet_id, s.assign_mode,
        slot.opens || null, slot.opensBeforeMinutes || 0, slot.due, slot.closes || null, slot.closesAfterMinutes || 60,
        s.id, day, slot.slot, slot.label, s.template_id, s.library_code, scope.timezone, s.requires_review]);
      if (!task) continue;
      made += 1;
      await templates.insertItems(db, "business_task_items", scope.businessId, "task_id", task.id, items);
      if (items.length) await recount(db, scope.businessId, task.id);
      for (const a of assignees) {
        await db.query(`INSERT INTO business_task_assignees (business_id, task_id, kind, user_id, employee_id, resource_id, role_id, business_role_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [scope.businessId, task.id, a.kind, a.user_id, a.employee_id, a.resource_id, a.role_id, a.business_role_id]);
      }
    }
  }
  await db.query("UPDATE business_task_schedules SET generated_through = $3 WHERE business_id = $1 AND id = $2", [scope.businessId, s.id, to]);
  return made;
}

// The counters a list shows without opening the checklist.
async function recount(db, businessId, taskId) {
  await db.query(`UPDATE business_tasks t SET
      item_count = x.items, answered_count = x.answered, failed_count = x.failed,
      score_percent = CASE WHEN x.scored > 0 THEN round(100.0 * (x.scored - x.failed) / x.scored, 2) END,
      critical_failed = x.critical_failed, updated_at = now()
    FROM (SELECT count(*) FILTER (WHERE kind <> 'section') AS items,
                 count(*) FILTER (WHERE kind <> 'section' AND answered) AS answered,
                 count(*) FILTER (WHERE failed) AS failed,
                 count(*) FILTER (WHERE answered AND kind IN ('yes_no', 'number', 'choice')) AS scored,
                 COALESCE(bool_or(failed AND critical), FALSE) AS critical_failed
          FROM business_task_items WHERE business_id = $1 AND task_id = $2) x
    WHERE t.business_id = $1 AND t.id = $2`, [businessId, taskId]);
}

// Throttle: a busy screen polling every few seconds checks at most this often.
const lastRun = new Map();
const THROTTLE_MS = 20000;

async function ensure(scope, { force = false } = {}) {
  const key = scope.businessId;
  const now = Date.now();
  if (!force && lastRun.has(key) && now - lastRun.get(key) < THROTTLE_MS) return { made: 0, missed: 0, skipped: true };
  lastRun.set(key, now);
  const today = localToday(scope.timezone);
  return repo.transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock($1, $2::int)", [LOCK_KEY, scope.businessId]);
    const schedules = await repo.all(db, `SELECT *, starts_on::text AS starts_on, ends_on::text AS ends_on, generated_through::text AS generated_through,
        due_times::text[] AS due_times FROM business_task_schedules
      WHERE business_id = $1 AND active AND (generated_through IS NULL OR generated_through < LEAST($2::date + $3::int, COALESCE(ends_on, 'infinity'::date)))
        AND starts_on <= $2::date + $3::int`, [scope.businessId, today, AHEAD_DAYS]);
    let made = 0;
    for (const s of schedules) made += await generateSchedule(db, scope, s, today);
    // Missed: the window closed and it was not done. One history line each.
    const missed = await repo.all(db, `WITH m AS (
        UPDATE business_tasks SET status = 'missed', updated_at = now()
        WHERE business_id = $1 AND status IN ('todo', 'in_progress') AND closes_at IS NOT NULL AND closes_at < now()
        RETURNING id)
      INSERT INTO business_task_history (business_id, task_id, action, details) SELECT $1, id, 'missed', '{}' FROM m RETURNING task_id`, [scope.businessId]);
    return { made, missed: missed.length };
  });
}

const forget = (businessId) => lastRun.delete(businessId);

// --- Schedules (the recurring rules) ---------------------------------------------

function readSchedule(body) {
  const frequency = v.requiredEnum(body.frequency, "Repeats", FREQUENCIES);
  const times = body.dueTimes === undefined || body.dueTimes === null ? ["18:00"] : v.requiredArray(body.dueTimes, "Times");
  if (!times.length || times.length > 12) fail(400, "Give 1 to 12 times a day");
  const dueTimes = [...new Set(times.map((t) => timeText(t, "Time")))];
  const weekdays = body.weekdays === undefined || body.weekdays === null ? null
    : [...new Set(v.requiredArray(body.weekdays, "Days").map((d) => v.requiredNumber(d, "Day", { min: 0, max: 6 })))].filter(Number.isInteger);
  const s = {
    title: v.requiredString(body.title, "Title", 160),
    description: v.optionalString(body.description, "Description", 2000),
    category: category(body.category),
    priority: v.optionalEnum(body.priority, "Priority", PRIORITIES, "normal"),
    frequency,
    everyN: frequency === "every_n_days" ? v.requiredNumber(body.everyN, "Every how many days", { min: 1, max: 365 }) : null,
    weekdays: frequency === "weekdays" ? (weekdays && weekdays.length ? weekdays : [1, 2, 3, 4, 5, 6]) : frequency === "weekly" ? weekdays : null,
    monthDay: frequency === "monthly" ? v.requiredNumber(body.monthDay, "Day of the month", { min: 1, max: 31 }) : null,
    dueTimes,
    shiftId: frequency === "per_shift" && body.shiftId ? id(body.shiftId, "Shift") : null,
    windowMinutes: body.windowMinutes === undefined || body.windowMinutes === null || body.windowMinutes === "" ? null
      : v.requiredNumber(body.windowMinutes, "Opens before it is due (minutes)", { min: 5, max: 1440 }),
    startsOn: dateText(body.startsOn, "Starts on"),
    endsOn: dateText(body.endsOn, "Stops on"),
    requiresReview: body.requiresReview === undefined ? null : v.requiredBoolean(body.requiresReview, "Needs review"),
    active: v.requiredBoolean(body.active, "Active", true),
  };
  if (frequency === "weekly" && (!s.weekdays || !s.weekdays.length)) fail(400, "Choose the days of the week");
  if (s.endsOn && s.startsOn && s.endsOn < s.startsOn) fail(400, "It stops before it starts");
  return s;
}

const shapeSchedule = (row) => ({
  id: Number(row.id), title: row.title, description: row.description, category: row.category_code, priority: row.priority,
  templateId: row.template_id ? Number(row.template_id) : null, libraryCode: row.library_code, templateName: row.template_name || null,
  placeId: Number(row.outlet_id || row.location_id) || null, placeName: row.place_name || null,
  assignMode: row.assign_mode, assignees: row.assignees || [], assigneeNames: row.assignee_names || null,
  frequency: row.frequency, everyN: row.every_n, weekdays: row.weekdays, monthDay: row.month_day,
  dueTimes: (row.due_times || []).map((t) => String(t).slice(0, 5)), shiftId: row.shift_id ? Number(row.shift_id) : null,
  windowMinutes: row.window_minutes, startsOn: row.starts_on, endsOn: row.ends_on, requiresReview: row.requires_review, active: row.active,
  compliance: row.due_30 !== undefined ? { due: Number(row.due_30), done: Number(row.done_30), onTime: Number(row.on_time_30), missed: Number(row.missed_30) } : undefined,
});

const scheduleSelect = `SELECT s.*, s.starts_on::text AS starts_on, s.ends_on::text AS ends_on, s.due_times::text[] AS due_times,
  COALESCE((SELECT name FROM outlets o WHERE o.id = s.outlet_id), (SELECT name FROM business_locations l WHERE l.business_id = s.business_id AND l.id = s.location_id)) AS place_name,
  (SELECT name FROM business_task_templates tt WHERE tt.business_id = s.business_id AND tt.id = s.template_id) AS template_name,
  COALESCE((SELECT json_agg(json_build_object('kind', a.kind, 'id', COALESCE(a.user_id, a.employee_id, a.resource_id, a.role_id, a.business_role_id),
     'name', COALESCE(u.name, e.name, r.name, ro.name, br.name)) ORDER BY a.id)
   FROM business_task_assignees a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN employees e ON e.id = a.employee_id
   LEFT JOIN business_resources r ON r.business_id = a.business_id AND r.id = a.resource_id LEFT JOIN roles ro ON ro.id = a.role_id
   LEFT JOIN business_roles br ON br.business_id = a.business_id AND br.id = a.business_role_id
   WHERE a.business_id = s.business_id AND a.schedule_id = s.id), '[]') AS assignees`;

async function list(scope, query = {}) {
  await scope.require("tasks.view");
  const today = localToday(scope.timezone);
  const from = addDays(today, -29);
  const rows = await repo.all(repo.pool, `${scheduleSelect},
      (SELECT count(*) FROM business_tasks t WHERE t.business_id = s.business_id AND t.schedule_id = s.id AND t.occurrence_date BETWEEN $2 AND $3 AND t.status <> 'cancelled' AND (t.due_at < now() OR t.status = 'done')) AS due_30,
      (SELECT count(*) FROM business_tasks t WHERE t.business_id = s.business_id AND t.schedule_id = s.id AND t.occurrence_date BETWEEN $2 AND $3 AND t.status = 'done') AS done_30,
      (SELECT count(*) FROM business_tasks t WHERE t.business_id = s.business_id AND t.schedule_id = s.id AND t.occurrence_date BETWEEN $2 AND $3 AND t.status = 'done' AND t.completed_at <= t.due_at) AS on_time_30,
      (SELECT count(*) FROM business_tasks t WHERE t.business_id = s.business_id AND t.schedule_id = s.id AND t.occurrence_date BETWEEN $2 AND $3 AND t.status = 'missed') AS missed_30
    FROM business_task_schedules s WHERE s.business_id = $1 AND ($4::bigint IS NULL OR s.outlet_id IS NULL OR s.outlet_id = $4)
    AND ($5::boolean OR s.active) ORDER BY s.active DESC, s.title`, [scope.businessId, from, today, scope.outletScope, query.all === "1" || query.all === "true"]);
  return rows.map(shapeSchedule);
}

async function one(scope, scheduleId) {
  await scope.require("tasks.view");
  const row = await repo.one(repo.pool, `${scheduleSelect} FROM business_task_schedules s WHERE s.business_id = $1 AND s.id = $2`, [scope.businessId, id(scheduleId, "Recurring task")]);
  if (!row) fail(404, "Recurring task not found");
  return shapeSchedule(row);
}

async function save(scope, scheduleId, body) {
  await scope.require("tasks.assign");
  const s = readSchedule(body);
  const result = await repo.transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock($1, $2::int)", [LOCK_KEY, scope.businessId]);
    const existing = scheduleId ? await repo.one(db, "SELECT *, starts_on::text AS starts_on_text FROM business_task_schedules WHERE business_id = $1 AND id = $2 FOR UPDATE", [scope.businessId, id(scheduleId, "Recurring task")]) : null;
    if (scheduleId && !existing) fail(404, "Recurring task not found");
    const source = await templates.resolve(db, scope, { templateId: body.templateId ?? existing?.template_id, libraryCode: body.libraryCode ?? (body.templateId ? null : existing?.library_code) });
    const place = await people.readPlace(db, scope, body);
    const { mode, rows } = await people.readAssignees(db, scope, body.assignMode, body.assignees);
    if (s.shiftId && !(await repo.one(db, "SELECT 1 FROM shifts WHERE id = $1 AND restaurant_id = $2", [s.shiftId, scope.restaurantId]))) fail(400, "Shift not found");
    if (s.frequency === "per_shift" && scope.world === "restaurant" && !(await repo.one(db, "SELECT 1 FROM shifts WHERE restaurant_id = $1 AND status = 'active'", [scope.restaurantId]))) {
      fail(400, "Set up shifts first (Staff › Shifts & roster), or choose times of day instead");
    }
    const startsOn = s.startsOn || existing?.starts_on_text || localToday(scope.timezone);
    const values = [scope.businessId, s.title, s.description, source?.templateId || null, source?.libraryCode || null, s.category, s.priority,
      place.locationId, place.outletId, mode, s.frequency, s.everyN, s.weekdays, s.monthDay, s.dueTimes, s.shiftId, s.windowMinutes,
      startsOn, s.endsOn, s.requiresReview ?? source?.requiresReview ?? false, s.active, scope.userId];
    let row;
    if (existing) {
      row = await repo.one(db, `UPDATE business_task_schedules SET title = $2, description = $3, template_id = $4, library_code = $5, category_code = $6, priority = $7,
          location_id = $8, outlet_id = $9, assign_mode = $10, frequency = $11, every_n = $12, weekdays = $13, month_day = $14, due_times = $15::time[],
          shift_id = $16, window_minutes = $17, starts_on = $18, ends_on = $19, requires_review = $20, active = $21, updated_by = $22, updated_at = now(),
          generated_through = NULL
        WHERE business_id = $1 AND id = $23 RETURNING *`, [...values, existing.id]);
      // Occurrences not started yet that are still to come follow the new rule; done, started and past ones stay as they are.
      await db.query(`DELETE FROM business_tasks WHERE business_id = $1 AND schedule_id = $2 AND status = 'todo' AND started_at IS NULL AND answered_count = 0
        AND (opens_at IS NULL OR opens_at > now()) AND due_at > now()
        AND NOT EXISTS (SELECT 1 FROM business_task_comments c WHERE c.business_id = $1 AND c.task_id = business_tasks.id)
        AND NOT EXISTS (SELECT 1 FROM business_task_files f WHERE f.business_id = $1 AND f.task_id = business_tasks.id)`, [scope.businessId, existing.id]);
      // Days already made stay made: generation resumes after the last one still standing.
      await db.query(`UPDATE business_task_schedules s SET generated_through = (SELECT max(occurrence_date) FROM business_tasks t WHERE t.business_id = s.business_id AND t.schedule_id = s.id)
        WHERE business_id = $1 AND id = $2`, [scope.businessId, existing.id]);
    } else {
      row = await repo.one(db, `INSERT INTO business_task_schedules (business_id, title, description, template_id, library_code, category_code, priority,
          location_id, outlet_id, assign_mode, frequency, every_n, weekdays, month_day, due_times, shift_id, window_minutes, starts_on, ends_on,
          requires_review, active, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::time[], $16, $17, $18, $19, $20, $21, $22, $22) RETURNING *`, values);
    }
    await people.saveAssignees(db, scope, { scheduleId: row.id }, rows);
    await repo.audit(db, scope, existing ? "task_schedule.updated" : "task_schedule.created", row.id, { title: s.title, frequency: s.frequency, active: s.active });
    return row;
  });
  forget(scope.businessId);
  await ensure(scope, { force: true });
  return one(scope, result.id);
}

async function setActive(scope, scheduleId, body) {
  await scope.require("tasks.assign");
  const active = v.requiredBoolean(body.active, "Active");
  await repo.transaction(async (db) => {
    const row = await repo.one(db, "SELECT id, title FROM business_task_schedules WHERE business_id = $1 AND id = $2 FOR UPDATE", [scope.businessId, id(scheduleId, "Recurring task")]);
    if (!row) fail(404, "Recurring task not found");
    await db.query("UPDATE business_task_schedules SET active = $3, updated_by = $4, updated_at = now() WHERE business_id = $1 AND id = $2", [scope.businessId, row.id, active, scope.userId]);
    // Paused: the occurrences still to come and not started are cancelled.
    if (!active) {
      await db.query(`UPDATE business_tasks SET status = 'cancelled', cancelled_at = now(), cancelled_by = $3, cancel_reason = 'Recurring task paused', updated_at = now()
        WHERE business_id = $1 AND schedule_id = $2 AND status = 'todo' AND started_at IS NULL AND due_at > now()`, [scope.businessId, row.id, scope.userId]);
    }
    await repo.audit(db, scope, active ? "task_schedule.resumed" : "task_schedule.paused", row.id, { title: row.title });
  });
  forget(scope.businessId);
  if (active) await ensure(scope, { force: true });
  return one(scope, scheduleId);
}

// A schedule's day-by-day record for the compliance strip.
async function compliance(scope, scheduleId, query = {}) {
  await scope.require("tasks.view");
  const today = localToday(scope.timezone);
  const to = dateText(query.to, "To") || today;
  const from = dateText(query.from, "From") || addDays(to, -29);
  if (daysBetween(from, to) > 366 || from > to) fail(400, "Choose up to a year");
  const rows = await repo.all(repo.pool, `SELECT occurrence_date::text AS day, occurrence_slot AS slot, status, due_at, completed_at, failed_count, critical_failed, id
    FROM business_tasks WHERE business_id = $1 AND schedule_id = $2 AND occurrence_date BETWEEN $3 AND $4 ORDER BY occurrence_date, occurrence_slot`,
  [scope.businessId, id(scheduleId, "Recurring task"), from, to]);
  return { from, to, days: rows };
}

module.exports = { ensure, forget, recount, list, one, save, setActive, compliance, fallsOn, slotsOn, DAY_CUTOFF };
