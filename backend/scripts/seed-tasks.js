// Demo data for Tasks, issues & projects (modules/tasks), for the demo
// restaurant and each demo business of one administrator:
//
//   npm run seed:tasks -- --user-id <admin id> [--restaurant-id <id>]
//
// Per business: two of its own templates (copied from the library), three
// recurring tasks started three weeks ago (opening checklist, the type's
// frequent check such as a temperature log, a weekly audit) with most past
// days done and some missed, a failed reading today that raised an issue,
// a few one-off tasks (one waiting for review), hand-reported issues (open,
// fixed, closed) and a project from a template with progress.
//
// Idempotent: a business already seeded (business_audit "tasks.demo_seeded")
// is skipped. Never point it at a live database.
require("dotenv").config({ quiet: true });
const repo = require("../src/modules/tasks/repositories/tasks.repository");
const scopes = require("../src/modules/tasks/services/scope");
const templates = require("../src/modules/tasks/services/templates.service");
const recurrence = require("../src/modules/tasks/services/recurrence.service");
const tasks = require("../src/modules/tasks/services/tasks.service");
const issues = require("../src/modules/tasks/services/issues.service");
const projects = require("../src/modules/tasks/services/projects.service");
const users = require("../src/modules/access/repositories/user.repository");
const { localToday, addDays } = require("../src/modules/tasks/services/common");

const PLAN = {
  restaurant: { frequent: "restaurant.temperature_log", opening: "restaurant.opening", weekly: "restaurant.fssai_hygiene", copy: ["restaurant.closing", "restaurant.kitchen_cleaning"] },
  grocery: { frequent: "supermarket.chiller", opening: "common.opening", weekly: "grocery.expiry_check", copy: ["grocery.month_end_stock", "grocery.bin_cleaning"] },
  supermarket: { frequent: "supermarket.chiller", opening: "common.opening", weekly: "supermarket.price_audit", copy: ["supermarket.planogram", "grocery.expiry_check"] },
  wholesale: { frequent: "wholesale.vehicle", opening: "common.opening", weekly: "wholesale.beat_review", copy: ["wholesale.godown_audit", "wholesale.loading"] },
  fashion: { frequent: "fashion.trial_room", opening: "common.opening", weekly: "fashion.tagging", copy: ["fashion.window", "fashion.size_set"] },
  electronics: { frequent: "electronics.demo_units", opening: "common.opening", weekly: "electronics.serial_audit", copy: ["electronics.warranty_cards", "electronics.earthing"] },
  pharmacy: { frequent: "pharmacy.fridge", opening: "common.opening", weekly: "pharmacy.h1_register", copy: ["pharmacy.expiry", "pharmacy.narcotics"] },
  books: { frequent: "books.stationery", opening: "common.opening", weekly: "books.new_arrivals", copy: ["books.school_season", "books.shelf_count"] },
  salon: { frequent: "salon.sanitisation", opening: "common.opening", weekly: "salon.product_stock", copy: ["salon.sterilisation", "salon.spa_room"] },
  healthcare: { frequent: "healthcare.sample_fridge", opening: "healthcare.room_ready", weekly: "healthcare.calibration", copy: ["healthcare.bmw", "healthcare.bmw_register"] },
  meat: { frequent: "meat.cold_room", opening: "common.opening", weekly: "grocery.scale_calibration", copy: ["meat.sanitising", "meat.freshness"] },
  weight_retail: { frequent: "weight.sweets_display", opening: "common.opening", weekly: "weight.moisture", copy: ["grocery.scale_calibration", "weight.packing"] },
};

const ISSUES = [
  { title: "AC in the front area not cooling", severity: "high", category: "maintenance", assetLabel: "Split AC 2 (front)", state: "open" },
  { title: "Water seepage behind the store rack", severity: "medium", category: "maintenance", assetLabel: "Back store wall", state: "in_progress" },
  { title: "First-aid box out of burn cream", severity: "low", category: "health_safety", state: "closed" },
  { title: "Inverter beeping, battery not holding charge", severity: "high", category: "maintenance", assetLabel: "Inverter (billing counter)", state: "resolved" },
];

const ONE_OFF = [
  { title: "Book the annual pest control contract", category: "procurement", priority: "high", days: 2 },
  { title: "Print new price boards for the festival", category: "marketing", priority: "normal", days: 4 },
  { title: "Call the electrician about the flickering tube light", category: "maintenance", priority: "normal", days: -1 },
  { title: "Interview two candidates for the counter job", category: "hiring", priority: "normal", days: 1, review: true },
];

// A value that passes an item (for the past days marked done).
const passing = (i) => {
  switch (i.kind) {
    case "checkbox": return { value_bool: true };
    case "yes_no": return { value_bool: i.expected !== "no" };
    case "number": {
      const lo = i.min_value === null ? null : Number(i.min_value), hi = i.max_value === null ? null : Number(i.max_value);
      const v = lo !== null && hi !== null ? Math.round(((lo + hi) / 2) * 10) / 10 : lo !== null ? lo + 1 : hi !== null ? hi - 1 : 1;
      return { value_number: v };
    }
    case "choice": return { value_choice: (i.options || []).find((o) => !o.fail)?.label || null };
    case "text": return { value_text: "All fine" };
    default: return {};
  }
};

async function adminScope(kind, user, businessId) {
  if (kind === "restaurant") return scopes.forRestaurant({ user });
  return scopes.forBusiness({ user: { id: user.id, name: user.name }, params: { businessId } });
}

async function seedBusiness(scope, owner) {
  const done = await repo.one(repo.pool, "SELECT 1 FROM business_audit WHERE business_id = $1 AND action = 'tasks.demo_seeded'", [scope.businessId]);
  if (done) return console.log(`  ${scope.businessName}: already seeded, skipped`);
  const plan = PLAN[scope.businessType] || PLAN.grocery;
  const today = localToday(scope.timezone);

  // Own templates: copies of two library templates.
  for (const code of plan.copy) {
    const exists = await repo.one(repo.pool, "SELECT 1 FROM business_task_templates WHERE business_id = $1 AND library_code = $2", [scope.businessId, code]);
    if (!exists) await templates.copy(scope, { libraryCode: code });
  }

  // Recurring tasks, three weeks of history.
  const starts = addDays(today, -20);
  const frequent = templates.libraryOne(scope, plan.frequent);
  const weekly = templates.libraryOne(scope, plan.weekly);
  const opening = templates.libraryOne(scope, plan.opening);
  const made = [];
  for (const [t, extra] of [
    [opening, { frequency: "daily", dueTimes: opening.suggested?.times || ["10:00"], windowMinutes: 120 }],
    [frequent, { frequency: frequent.suggested?.frequency === "weekly" ? "daily" : frequent.suggested?.frequency || "daily", weekdays: frequent.suggested?.weekdays,
      dueTimes: frequent.suggested?.times || ["10:00", "17:00"], windowMinutes: frequent.suggested?.windowMinutes || 120 }],
    [weekly, { frequency: "weekly", weekdays: weekly.suggested?.weekdays || [1], dueTimes: weekly.suggested?.times || ["16:00"] }],
  ]) {
    const exists = await repo.one(repo.pool, "SELECT id FROM business_task_schedules WHERE business_id = $1 AND library_code = $2", [scope.businessId, t.code]);
    if (exists) { made.push(exists.id); continue; }
    const saved = await recurrence.save(scope, null, { title: t.name, libraryCode: t.code, category: t.category, priority: t.priority, assignMode: "on_shift", startsOn: starts, ...extra,
      weekdays: ["weekly", "weekdays"].includes(extra.frequency) ? extra.weekdays || [1, 2, 3, 4, 5, 6] : null, monthDay: extra.frequency === "monthly" ? 1 : null, everyN: extra.frequency === "every_n_days" ? 2 : null });
    made.push(saved.id);
  }

  // Most past days were done (some a little late); about one in eight was missed.
  await repo.transaction(async (db) => {
    const past = await repo.all(db, `SELECT id, due_at FROM business_tasks WHERE business_id = $1 AND schedule_id = ANY($2::bigint[]) AND status = 'missed' ORDER BY id`, [scope.businessId, made]);
    for (const task of past) {
      if (task.id % 8 === 3) continue;
      const items = await repo.all(db, "SELECT * FROM business_task_items WHERE business_id = $1 AND task_id = $2", [scope.businessId, task.id]);
      for (const item of items.filter((i) => i.kind !== "section")) {
        const v = passing(item);
        await db.query(`UPDATE business_task_items SET value_bool = $3, value_number = $4, value_text = $5, value_choice = $6, answered = TRUE, answered_by = $7,
            answered_at = $8::timestamptz - interval '10 minutes' WHERE business_id = $1 AND id = $2`,
        [scope.businessId, item.id, v.value_bool ?? null, v.value_number ?? null, v.value_text ?? null, v.value_choice ?? null, owner.id, task.due_at]);
      }
      const minutes = task.id % 10 === 0 ? 25 : -((task.id * 7) % 50) - 5;
      await db.query(`UPDATE business_tasks SET status = 'done', started_at = due_at + make_interval(mins => $3::int - 15), started_by = $4,
          completed_at = due_at + make_interval(mins => $3::int), completed_by = $4 WHERE business_id = $1 AND id = $2`, [scope.businessId, task.id, minutes, owner.id]);
      await db.query("DELETE FROM business_task_history WHERE business_id = $1 AND task_id = $2 AND action = 'missed'", [scope.businessId, task.id]);
      await db.query("INSERT INTO business_task_history (business_id, task_id, action, details, actor_id, created_at) SELECT $1, $2, 'completed', '{}', $3, completed_at FROM business_tasks WHERE id = $2",
        [scope.businessId, task.id, owner.id]);
      await recurrence.recount(db, scope.businessId, task.id);
    }
  });

  // Today's frequent check: one reading out of range raises an issue.
  const todayTask = await repo.one(repo.pool, `SELECT id FROM business_tasks WHERE business_id = $1 AND schedule_id = $2 AND occurrence_date = $3 AND status IN ('todo', 'in_progress')
    ORDER BY occurrence_slot LIMIT 1`, [scope.businessId, made[1], today]);
  if (todayTask) {
    const detail = await tasks.detail(scope, todayTask.id);
    const reading = detail.items.find((i) => i.kind === "number" && (i.minValue !== null || i.maxValue !== null) && i.raiseIssue);
    const yesNo = detail.items.find((i) => i.kind === "yes_no" && i.raiseIssue);
    const opensLater = detail.opensAt && new Date(detail.opensAt) > new Date();
    if (!opensLater) {
      if (reading) await tasks.answer(scope, todayTask.id, reading.id, { value: (reading.maxValue ?? reading.minValue) + 3, note: "Door was left open after the delivery" });
      else if (yesNo) await tasks.answer(scope, todayTask.id, yesNo.id, { value: yesNo.expected === "no" ? "yes" : "no" });
      const first = detail.items.find((i) => i.kind === "checkbox");
      if (first) await tasks.answer(scope, todayTask.id, first.id, { value: true });
    }
  }

  // One-off tasks (one for the Manager role).
  const managerRole = scope.world === "restaurant"
    ? { kind: "role", id: (await repo.one(repo.pool, "SELECT id FROM roles WHERE code = 'MANAGER' AND restaurant_id IS NULL")).id }
    : { kind: "business_role", id: (await repo.one(repo.pool, "SELECT id FROM business_roles WHERE business_id = $1 AND template_code = 'manager'", [scope.businessId])).id };
  for (const [index, o] of ONE_OFF.entries()) {
    const due = new Date(`${addDays(today, o.days)}T${o.days < 0 ? "11:00" : "18:00"}:00+05:30`).toISOString();
    const t = await tasks.create(scope, { title: o.title, category: o.category, priority: o.priority, dueAt: due, requiresReview: Boolean(o.review),
      ...(index === 1 ? { assignMode: "role", assignees: [managerRole] } : {}),
      ...(index === 3 ? { items: [{ kind: "text", label: "Candidate names and phone numbers" }, { kind: "choice", label: "Decision", options: [{ label: "Hire" }, { label: "Second round" }, { label: "Not suitable" }] }] } : {}) });
    if (o.review) {
      await tasks.answer(scope, t.id, t.items[0].id, { value: "Ravi Kumar 98480 22110, Meena S 99000 11223" });
      await tasks.answer(scope, t.id, t.items[1].id, { value: "Second round" });
      await tasks.complete(scope, t.id, { note: "Both can start next month" });
    }
  }

  // Issues reported by hand, in each state.
  for (const i of ISSUES) {
    const issue = await issues.create(scope, { title: i.title, severity: i.severity, category: i.category, assetLabel: i.assetLabel || null, assigneeId: owner.id });
    if (i.state === "in_progress") await issues.setStatus(scope, issue.id, { status: "in_progress" });
    if (i.state === "resolved" || i.state === "closed") await issues.setStatus(scope, issue.id, { status: "resolved", note: i.state === "closed" ? "Bought two tubes of burn cream" : "Battery replaced by the dealer under warranty" });
    if (i.state === "closed") await issues.setStatus(scope, issue.id, { status: "closed" });
    if (i.state === "open") await issues.comment(scope, issue.id, { body: "Technician coming tomorrow between 11 and 1." });
  }

  // A project from a template, with some progress.
  const project = await projects.create(scope, { name: scope.world === "restaurant" ? "Diwali festival menu & décor" : "Diwali festival sale", templateCode: "project.festival_sale",
    startOn: addDays(today, -6), description: "Offers, stock and the shop front ready before the festival week." });
  for (const task of project.tasks.slice(0, 5)) await tasks.complete(scope, task.id, {});
  await projects.saveMilestone(scope, project.id, project.milestoneList[0].id, { done: true });

  await repo.transaction((db) => repo.audit(db, scope, "tasks.demo_seeded", null, { at: new Date().toISOString() }));
  console.log(`  ${scope.businessName}: templates, 3 recurring tasks, ${ONE_OFF.length} one-off tasks, ${ISSUES.length} issues and a project`);
}

async function main() {
  const at = (name) => (process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : null);
  const userId = at("--user-id");
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Usage: npm run seed:tasks -- --user-id <admin id> [--restaurant-id <id>]");
  if (process.env.NODE_ENV === "production") throw new Error("Demo data is not for a live database");
  const profile = await users.findProfileById(userId);
  if (!profile) throw new Error("User not found");
  const user = { id: Number(profile.id), name: profile.name, restaurantId: profile.restaurant_id, outletId: null, permissions: profile.permissions, features: profile.features || [] };
  const restaurantId = at("--restaurant-id") || profile.restaurant_id;
  if (restaurantId) {
    if (Number(restaurantId) !== Number(profile.restaurant_id)) throw new Error("The user must belong to that restaurant");
    console.log("Restaurant:");
    await seedBusiness(await adminScope("restaurant", user), user);
  }
  const demos = await repo.all(repo.pool, `SELECT b.id FROM businesses b JOIN business_memberships m ON m.business_id = b.id AND m.user_id = $1 AND m.active
    WHERE b.is_demo AND b.status = 'active' AND b.business_type <> 'restaurant' ORDER BY b.id`, [userId]);
  if (demos.length) console.log("Demo businesses:");
  for (const d of demos) await seedBusiness(await adminScope("business", user, d.id), user);
}

if (require.main === module) {
  main().then(() => console.log("Tasks demo data ready.")).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => repo.pool.end());
}
module.exports = { seedBusiness };
