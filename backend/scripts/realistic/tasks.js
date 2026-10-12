// Tasks, issues and projects for a realistic demo business, built on the same
// steps as seed-tasks.js (the app's own task services; past occurrences marked
// done the way seed-tasks.js does):
//
//   - an opening and a closing checklist every day for the last month, done
//     on most days (some late, about one in nine missed), by the manager;
//   - the type's daily reading (chiller, cold room, medicine fridge, scale,
//     van fuel, sterilisation, IMEI tally…) by the stock keeper or cashier,
//     with today's reading out of range, which raises an issue;
//   - a weekly audit, two of the library's templates copied as the shop's own,
//     a few one-off jobs and hand-reported issues in each state;
//   - "Diwali preparation 2026", a project whose tasks are assigned to the
//     staff and stand done, in progress, overdue and still to do.
//
// Once per business (business_audit "tasks.demo_seeded"), like seed-tasks.js.
const repo = require('../../src/modules/tasks/repositories/tasks.repository');
const scopes = require('../../src/modules/tasks/services/scope');
const templates = require('../../src/modules/tasks/services/templates.service');
const recurrence = require('../../src/modules/tasks/services/recurrence.service');
const tasks = require('../../src/modules/tasks/services/tasks.service');
const issues = require('../../src/modules/tasks/services/issues.service');
const projects = require('../../src/modules/tasks/services/projects.service');
const { localToday, addDays } = require('../../src/modules/tasks/services/common');

const PLAN = {
  grocery: { reading: 'supermarket.chiller', weekly: 'grocery.expiry_check', copy: ['grocery.month_end_stock', 'grocery.udhaar_followup'] },
  supermarket: { reading: 'supermarket.chiller', weekly: 'supermarket.price_audit', copy: ['supermarket.planogram', 'supermarket.counter_audit'] },
  wholesale: { reading: 'wholesale.vehicle', weekly: 'wholesale.beat_review', copy: ['wholesale.godown_audit', 'wholesale.cheque_deposit'] },
  fashion: { reading: 'fashion.trial_room', weekly: 'fashion.size_set', copy: ['fashion.window', 'fashion.tagging'] },
  electronics: { reading: 'electronics.serial_audit', weekly: 'electronics.earthing', copy: ['electronics.warranty_cards', 'electronics.service_followup'] },
  pharmacy: { reading: 'pharmacy.fridge', weekly: 'supermarket.price_audit', copy: ['pharmacy.expiry', 'pharmacy.returns'] },
  books: { reading: 'books.school_season', weekly: 'books.shelf_count', copy: ['books.stationery', 'books.reorder'] },
  salon: { reading: 'salon.sterilisation', weekly: 'salon.product_stock', copy: ['salon.sanitisation', 'salon.linen'] },
  healthcare: { reading: 'healthcare.sample_fridge', weekly: 'healthcare.calibration', copy: ['healthcare.bmw', 'pharmacy.fridge'] },
  meat: { reading: 'meat.cold_room', weekly: 'grocery.scale_calibration', copy: ['meat.sanitising', 'meat.freshness'] },
  weight_retail: { reading: 'grocery.scale_calibration', weekly: 'weight.moisture', copy: ['weight.packing', 'weight.repacking'] },
};

const ISSUES = [
  { title: 'Inverter beeping, battery not holding charge', severity: 'high', category: 'maintenance', assetLabel: 'Inverter (billing counter)', state: 'in_progress', note: 'Dealer coming Saturday to test the battery' },
  { title: 'Water seepage behind the back rack after the rain', severity: 'medium', category: 'maintenance', assetLabel: 'Back store wall', state: 'open' },
  { title: 'Receipt printer cutting the paper half-way', severity: 'low', category: 'maintenance', assetLabel: 'Thermal printer, counter 1', state: 'resolved', note: 'Cutter blade cleaned; working' },
  { title: 'First-aid box out of burn cream and bandages', severity: 'low', category: 'health_safety', state: 'closed', note: 'Bought two tubes and a roll from the chemist' },
];
const ONE_OFF = [
  { title: 'Renew the trade licence with the municipal office', category: 'others', priority: 'high', days: 6 },
  { title: 'Get the fire extinguisher refilled', category: 'health_safety', priority: 'normal', days: -2 },
  { title: 'Order Diwali carry bags with the shop name', category: 'procurement', priority: 'normal', days: 3 },
];

// A value that passes an item (past days marked done), as in seed-tasks.js.
const passing = (i) => {
  switch (i.kind) {
    case 'checkbox': return { value_bool: true };
    case 'yes_no': return { value_bool: i.expected !== 'no' };
    case 'number': {
      const lo = i.min_value === null ? null : Number(i.min_value), hi = i.max_value === null ? null : Number(i.max_value);
      const v = lo !== null && hi !== null ? Math.round(((lo + hi) / 2) * 10) / 10 : lo !== null ? lo + 1 : hi !== null ? hi - 1 : 1;
      return { value_number: v };
    }
    case 'choice': return { value_choice: (i.options || []).find((o) => !o.fail)?.label || null };
    case 'text': return { value_text: 'All fine' };
    default: return {};
  }
};
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// Today's checklists already due (opening, weekly) were done by the manager on time;
// the daily reading is left as it is (it carries today's failed reading).
async function todayDone(sim) {
  const businessId = sim.business.id;
  const plan = PLAN[sim.business.business_type] || PLAN.grocery;
  const manager = sim.staff.find((s) => s.role === 'manager')?.user || sim.owner;
  const due = await repo.all(repo.pool, `SELECT t.id FROM business_tasks t JOIN business_task_schedules s ON s.business_id = t.business_id AND s.id = t.schedule_id
    WHERE t.business_id = $1 AND t.status IN ('todo', 'in_progress') AND t.due_at < now() AND s.library_code <> $2`, [businessId, plan.reading]);
  if (!due.length) return;
  await repo.transaction(async (db) => {
    for (const task of due) {
      const items = await repo.all(db, 'SELECT * FROM business_task_items WHERE business_id = $1 AND task_id = $2', [businessId, task.id]);
      for (const item of items.filter((i) => i.kind !== 'section' && !i.answered)) {
        const v = passing(item);
        await db.query(`UPDATE business_task_items SET value_bool = $3, value_number = $4, value_text = $5, value_choice = $6, answered = TRUE, answered_by = $7,
            answered_at = (SELECT due_at FROM business_tasks WHERE id = $8) - interval '12 minutes' WHERE business_id = $1 AND id = $2`,
        [businessId, item.id, v.value_bool ?? null, v.value_number ?? null, v.value_text ?? null, v.value_choice ?? null, manager.id, task.id]);
      }
      await db.query(`UPDATE business_tasks SET status = 'done', started_at = due_at - interval '20 minutes', started_by = $3,
          completed_at = due_at - interval '8 minutes', completed_by = $3 WHERE business_id = $1 AND id = $2`, [businessId, task.id, manager.id]);
      await db.query("INSERT INTO business_task_history (business_id, task_id, action, details, actor_id, created_at) SELECT $1, $2, 'completed', '{}', $3, completed_at FROM business_tasks WHERE id = $2",
        [businessId, task.id, manager.id]);
      await recurrence.recount(db, businessId, task.id);
    }
  });
}

async function seed(sim) {
  const businessId = sim.business.id;
  if (await repo.one(repo.pool, "SELECT 1 FROM business_audit WHERE business_id = $1 AND action = 'tasks.demo_seeded'", [businessId])) { await todayDone(sim); return null; }
  const owner = { id: sim.owner.id, name: sim.owner.name };
  const scope = await scopes.forBusiness({ user: owner, params: { businessId } });
  const plan = PLAN[scope.businessType] || PLAN.grocery;
  const today = localToday(scope.timezone);
  const role = async (code) => repo.one(repo.pool, 'SELECT id FROM business_roles WHERE business_id = $1 AND template_code = $2', [businessId, code]);
  const staffOf = (...roles) => sim.staff.filter((s) => roles.includes(s.role));
  const doer = (roles, n) => { const list = staffOf(...roles); return list.length ? list[n % list.length].user : owner; };

  for (const code of plan.copy) {
    if (!templates.libraryOne(scope, code)) continue;
    const exists = await repo.one(repo.pool, 'SELECT 1 FROM business_task_templates WHERE business_id = $1 AND library_code = $2', [businessId, code]);
    if (!exists) await templates.copy(scope, { libraryCode: code });
  }

  // Recurring checklists over the last month.
  const starts = addDays(today, -30);
  const manager = await role('manager');
  const keeper = sim.staff.some((s) => s.role === 'stock_keeper') ? await role('stock_keeper') : sim.staff.some((s) => s.role === 'cashier') ? await role('cashier') : manager;
  const opening = templates.libraryOne(scope, scope.businessType === 'healthcare' ? 'healthcare.room_ready' : 'common.opening');
  const closing = templates.libraryOne(scope, 'common.closing');
  const reading = templates.libraryOne(scope, plan.reading);
  const weekly = templates.libraryOne(scope, plan.weekly);
  const open = sim.def.open, close = sim.def.close;
  const schedules = [];
  for (const [t, extra, assignRole, roles] of [
    [opening, { frequency: 'daily', dueTimes: [hhmm(open + 15)], windowMinutes: 60 }, manager, ['manager']],
    [closing, { frequency: 'daily', dueTimes: [hhmm(Math.min(close + 10, 23 * 60 + 30))], windowMinutes: 60 }, manager, ['manager']],
    [reading, { frequency: 'daily', dueTimes: [hhmm(open + 90), hhmm(Math.max(open + 120, close - 120))], windowMinutes: 90 }, keeper, ['stock_keeper', 'cashier', 'manager']],
    [weekly, { frequency: 'weekly', weekdays: [1], dueTimes: [hhmm(Math.min(close - 60, 18 * 60))] }, manager, ['manager']],
  ]) {
    if (!t) continue;
    const exists = await repo.one(repo.pool, 'SELECT id FROM business_task_schedules WHERE business_id = $1 AND library_code = $2', [businessId, t.code]);
    if (exists) { schedules.push({ id: exists.id, roles, t }); continue; }
    const saved = await recurrence.save(scope, null, { title: t.name, libraryCode: t.code, category: t.category, priority: t.priority, startsOn: starts,
      assignMode: assignRole ? 'role' : 'on_shift', assignees: assignRole ? [{ kind: 'business_role', id: assignRole.id }] : undefined, ...extra,
      weekdays: extra.frequency === 'weekly' ? extra.weekdays : null });
    schedules.push({ id: saved.id, roles, t });
  }

  // Most past occurrences were done (some a little late) by the person on duty; about one in nine was missed.
  await repo.transaction(async (db) => {
    for (const s of schedules) {
      const past = await repo.all(db, `SELECT id, due_at FROM business_tasks WHERE business_id = $1 AND schedule_id = $2 AND status = 'missed' ORDER BY id`, [businessId, s.id]);
      for (const [n, task] of past.entries()) {
        if (task.id % 9 === 4) continue;
        const by = doer(s.roles, n);
        const items = await repo.all(db, 'SELECT * FROM business_task_items WHERE business_id = $1 AND task_id = $2', [businessId, task.id]);
        for (const item of items.filter((i) => i.kind !== 'section')) {
          const v = passing(item);
          await db.query(`UPDATE business_task_items SET value_bool = $3, value_number = $4, value_text = $5, value_choice = $6, answered = TRUE, answered_by = $7,
              answered_at = $8::timestamptz - interval '10 minutes' WHERE business_id = $1 AND id = $2`,
          [businessId, item.id, v.value_bool ?? null, v.value_number ?? null, v.value_text ?? null, v.value_choice ?? null, by.id, task.due_at]);
        }
        const minutes = task.id % 10 === 0 ? 25 : -((task.id * 7) % 50) - 5;
        await db.query(`UPDATE business_tasks SET status = 'done', started_at = due_at + make_interval(mins => $3::int - 15), started_by = $4,
            completed_at = due_at + make_interval(mins => $3::int), completed_by = $4 WHERE business_id = $1 AND id = $2`, [businessId, task.id, minutes, by.id]);
        await db.query("DELETE FROM business_task_history WHERE business_id = $1 AND task_id = $2 AND action = 'missed'", [businessId, task.id]);
        await db.query("INSERT INTO business_task_history (business_id, task_id, action, details, actor_id, created_at) SELECT $1, $2, 'completed', '{}', $3, completed_at FROM business_tasks WHERE id = $2",
          [businessId, task.id, by.id]);
        await recurrence.recount(db, businessId, task.id);
      }
    }
  });

  // Today's reading: one value out of range (or a failing answer), which raises an issue.
  const readingSchedule = schedules.find((s) => s.t === reading);
  const todayTask = readingSchedule && await repo.one(repo.pool, `SELECT id FROM business_tasks WHERE business_id = $1 AND schedule_id = $2 AND occurrence_date = $3 AND status IN ('todo', 'in_progress')
    ORDER BY occurrence_slot LIMIT 1`, [businessId, readingSchedule.id, today]);
  let raised = false;
  if (todayTask) {
    const detail = await tasks.detail(scope, todayTask.id);
    if (!(detail.opensAt && new Date(detail.opensAt) > new Date())) {
      const number = detail.items.find((i) => i.kind === 'number' && (i.minValue !== null || i.maxValue !== null) && i.raiseIssue);
      const yesNo = detail.items.find((i) => i.kind === 'yes_no' && i.raiseIssue);
      if (number) {
        const lo = number.minValue === null ? null : Number(number.minValue), hi = number.maxValue === null ? null : Number(number.maxValue);
        const unit = String(number.unit || '');
        // A believable miss: a chiller 3 °C too warm, a van low on fuel, a scale 20 g out, one IMEI missing.
        const out = unit.includes('°C') && hi !== null ? hi + 3 : unit.includes('%') && lo !== null ? Math.max(0, lo - 8)
          : hi !== null ? hi + (hi - (lo ?? hi) > 0 ? (hi - lo) * 1.5 : 1) : lo - Math.max(1, Math.round(Math.abs(lo) / 3));
        await tasks.answer(scope, todayTask.id, number.id, { value: Math.round(out * 1000) / 1000, note: 'Reading taken twice; door seal looks loose' });
        raised = true;
      } else if (yesNo) {
        await tasks.answer(scope, todayTask.id, yesNo.id, { value: yesNo.expected === 'no' ? 'yes' : 'no', note: 'Found during the check' });
        raised = true;
      }
      const first = detail.items.find((i) => i.kind === 'checkbox');
      if (first) await tasks.answer(scope, todayTask.id, first.id, { value: true });
    }
  }

  // One-off jobs (one for the manager role) and hand-reported issues.
  const titled = (table, column, text) => repo.one(repo.pool, `SELECT * FROM ${table} WHERE business_id = $1 AND ${column} = $2 LIMIT 1`, [businessId, text]);
  for (const [index, o] of ONE_OFF.entries()) {
    if (await titled('business_tasks', 'title', o.title)) continue;
    const due = new Date(`${addDays(today, o.days)}T${o.days < 0 ? '11:00' : '18:00'}:00+05:30`).toISOString();
    await tasks.create(scope, { title: o.title, category: o.category, priority: o.priority, dueAt: due, ...(index === 0 && manager ? { assignMode: 'role', assignees: [{ kind: 'business_role', id: manager.id }] } : {}) });
  }
  for (const i of ISSUES) {
    if (await titled('business_issues', 'title', i.title)) continue;
    const issue = await issues.create(scope, { title: i.title, severity: i.severity, category: i.category, assetLabel: i.assetLabel || null, assigneeId: owner.id });
    if (i.state === 'in_progress') { await issues.setStatus(scope, issue.id, { status: 'in_progress' }); await issues.comment(scope, issue.id, { body: i.note }); }
    if (i.state === 'resolved' || i.state === 'closed') await issues.setStatus(scope, issue.id, { status: 'resolved', note: i.note });
    if (i.state === 'closed') await issues.setStatus(scope, issue.id, { status: 'closed' });
  }

  // Diwali preparation: tasks given to the staff, in every state.
  const team = sim.staff.map((s) => s.user);
  const old = await titled('business_projects', 'name', 'Diwali preparation 2026');
  const project = old ? { ...(await projects.detail(scope, old.id)), reused: true } : await projects.create(scope, { name: 'Diwali preparation 2026', templateCode: 'project.festival_sale', startOn: addDays(today, -12), endOn: '2026-11-06',
    description: 'Festival stock, offers, the shop front and extra hands ready before Dhanteras (6 Nov) and Diwali (8 Nov).', memberIds: team.map((u) => u.id) });
  const list = project.reused ? [] : project.tasks || [];
  for (const [n, task] of list.entries()) {
    const person = team.length ? team[n % team.length] : owner;
    const due = new Date(`${addDays(today, n < 2 ? -3 + n : n < 4 ? -1 : 2 + n * 2)}T18:00:00+05:30`).toISOString();
    await tasks.update(scope, task.id, { assignMode: 'people', assignees: [{ kind: 'user', id: person.id }], dueAt: due });
    const theirs = team.length ? await scopes.forBusiness({ user: { id: person.id, name: person.name }, params: { businessId } }).catch(() => scope) : scope;
    try {
      if (n < 3) await tasks.complete(theirs, task.id, { note: n === 0 ? 'Done; photos in the group' : undefined });
      else if (n < 5) await tasks.start(theirs, task.id);
    } catch (error) {
      if (!/not yours|not open|permission|cannot/i.test(error.message)) throw error;
      if (n < 3) await tasks.complete(scope, task.id, {});
    }
  }
  if (!project.reused && project.milestoneList?.[0]) await projects.saveMilestone(scope, project.id, project.milestoneList[0].id, { done: true });

  await todayDone(sim);
  await repo.transaction((db) => repo.audit(db, scope, 'tasks.demo_seeded', null, { at: new Date().toISOString(), realistic: true }));
  return `tasks: ${schedules.length} checklists, ${raised ? 'a failed reading today, ' : ''}${ISSUES.length} issues, Diwali project with ${list.length} tasks`;
}

module.exports = { seed };
