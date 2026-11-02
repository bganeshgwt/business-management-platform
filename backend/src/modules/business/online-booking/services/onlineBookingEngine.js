const repo = require('../../core/repositories/business.repository');
const AppError = require('../../../../utils/AppError');
const rules = require('./onlineBookingRules');

// What a booking link offers, and when it is free: one engine for the guest's
// page and for the booking itself, by kind of business.
//
//   salon   a salon's timed services (one to three, back to back), its
//           stylists with their skills, weeks, leave and the salon's holidays
//           and hours, and its rooms (businessSalon.service.js books it: bookIn)
//   clinic  each doctor's OPD sessions by weekday, slot length and leave, the
//           consultation fee as the service, and each session's online share
//           (businessClinicDesk.service.js availabilityProblem checks it)
//   hours   anyone else (optical, garage, electronics, gym): the services given
//           a length on the link, the people at the location, its opening hours
//
// Every time shown and every booking counts what holds a person's time:
// bookings, and requests not yet answered nor expired
// (business_appointment_holds), the desk's and online alike. The page's times
// are worked out here from one read of the days shown; the booking re-checks
// under the business's lock with the type's own rules, so a time taken
// meanwhile is refused (409 slot_taken) with the next free ones.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const kindOf = (business) => (business.business_type === 'salon' ? 'salon' : business.business_type === 'healthcare' ? 'clinic' : 'hours');
const SALON_PLAN_ITEMS = `NOT EXISTS (SELECT 1 FROM salon_plans x WHERE x.business_id=s.business_id AND x.sku_id=s.id)
  AND NOT EXISTS (SELECT 1 FROM salon_settings y WHERE y.business_id=s.business_id AND y.fee_sku_id=s.id)`;
// A service's price as a guest pays it: the business's price with GST when its prices are before tax.
const shelfOf = (price, rate, taxMode) => {
  const paise = Math.round(Number(price) * 100);
  return ((taxMode === 'inclusive' ? paise : paise + Math.round((paise * Number(rate || 0)) / 100)) / 100).toFixed(2);
};
const time = (value) => (value ? String(value).slice(0, 5) : null);

// --- What the link offers ----------------------------------------------------------------------------

// { kind, services: [{ id, label, category, minutes, block, room, price }], people: [{ id, name, role, skills, … }],
//   rooms, salon: { opens, closes, depositPercent }, hours, clinic: { fees } }
// Only what is shown online; `all: true` lists what is hidden too (the settings screen), each with `shown`.
async function offer(db, business, link, { all = false } = {}) {
  const kind = kindOf(business);
  const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
  const taxMode = settings?.tax_mode || 'exclusive';
  const location = await repo.one(db, 'SELECT id,name,opening_hours FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, link.location_id]);
  const keep = (rows) => (all ? rows : rows.filter((row) => row.shown));
  if (kind === 'salon') {
    const salon = await repo.one(db, 'SELECT opens_at,closes_at,deposit_percent FROM salon_settings WHERE business_id=$1', [business.id])
      || { opens_at: '09:00', closes_at: '21:00', deposit_percent: 0 };
    const services = await repo.all(db, `SELECT s.id,s.label,s.price,s.tax_rate,COALESCE(c.name,p.category) AS category,ss.duration_minutes,ss.buffer_minutes,
        COALESCE(ss.needs_room,false) AS needs_room,COALESCE(ls.shown,true) AS shown
      FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      JOIN salon_services ss ON ss.business_id=s.business_id AND ss.sku_id=s.id
      LEFT JOIN catalog_categories c ON c.business_id=p.business_id AND c.id=p.category_id
      LEFT JOIN business_booking_link_services ls ON ls.link_id=$2 AND ls.sku_id=s.id
      WHERE s.business_id=$1 AND s.active AND p.active AND p.kind='service' AND ${SALON_PLAN_ITEMS}
      ORDER BY COALESCE(c.name,p.category) NULLS LAST,s.label`, [business.id, link.id]);
    const people = await repo.all(db, `SELECT r.id,r.name,r.role_label,COALESCE(pr.weekly_off,'{}') AS weekly_off,to_char(pr.works_from,'HH24:MI') AS works_from,
        to_char(pr.works_to,'HH24:MI') AS works_to,COALESCE(lp.shown,true) AS shown,
        COALESCE((SELECT json_agg(json_build_object('dow',w.dow,'off',w.off,'worksFrom',to_char(w.works_from,'HH24:MI'),'worksTo',to_char(w.works_to,'HH24:MI')))
          FROM salon_staff_week w WHERE w.business_id=r.business_id AND w.resource_id=r.id),'[]') AS week,
        COALESCE((SELECT json_agg(k.sku_id) FROM salon_staff_skills k WHERE k.business_id=r.business_id AND k.resource_id=r.id),'[]') AS skills
      FROM business_resources r LEFT JOIN salon_resource_profiles pr ON pr.business_id=r.business_id AND pr.resource_id=r.id
      LEFT JOIN business_booking_link_people lp ON lp.link_id=$2 AND lp.resource_id=r.id
      WHERE r.business_id=$1 AND r.location_id=$3 AND r.active AND COALESCE(pr.kind,'staff')='staff' ORDER BY r.name,r.id`, [business.id, link.id, link.location_id]);
    const rooms = await repo.all(db, `SELECT r.id,r.name FROM business_resources r JOIN salon_resource_profiles pr ON pr.business_id=r.business_id AND pr.resource_id=r.id
      WHERE r.business_id=$1 AND r.location_id=$2 AND r.active AND pr.kind='room' ORDER BY r.id`, [business.id, link.location_id]);
    return {
      kind, location, taxMode,
      salon: { opens: rules.minutesOf(time(salon.opens_at)), closes: rules.minutesOf(time(salon.closes_at)), depositPercent: Number(salon.deposit_percent || 0) },
      services: keep(services.map((s) => ({ id: Number(s.id), label: s.label, category: s.category || null, minutes: Number(s.duration_minutes),
        block: Number(s.duration_minutes) + Number(s.buffer_minutes || 0), room: Boolean(s.needs_room), price: shelfOf(s.price, s.tax_rate, taxMode),
        listPrice: s.price, shown: s.shown }))),
      people: keep(people.map((p) => ({ id: Number(p.id), name: p.name, role: p.role_label || null, weeklyOff: (p.weekly_off || []).map(Number),
        worksFrom: p.works_from, worksTo: p.works_to, week: p.week, skills: (p.skills || []).map(Number), shown: p.shown }))),
      rooms: rooms.map((r) => ({ id: Number(r.id), name: r.name })),
    };
  }
  if (kind === 'clinic') {
    const doctors = await repo.all(db, `SELECT r.id,r.name,r.role_label,p.speciality,p.slot_minutes,p.consultation_sku_id,p.follow_up_days,
        COALESCE(NULLIF(btrim(p.qualifications),''),g.qualification) AS qualifications,COALESCE(NULLIF(btrim(p.registration_no),''),g.registration_no) AS registration_no,
        COALESCE(NULLIF(btrim(p.council),''),g.council) AS council,cs.label AS fee_label,cs.price AS fee_price,cs.tax_rate AS fee_tax_rate,cs.active AS fee_active,
        fs.price AS follow_up_price,fs.tax_rate AS follow_up_tax_rate,COALESCE(lp.shown,true) AS shown,
        COALESCE((SELECT json_agg(json_build_object('dow',x.dow,'starts',to_char(x.starts,'HH24:MI'),'ends',to_char(x.ends,'HH24:MI'),'maxPatients',x.max_patients) ORDER BY x.dow,x.starts)
          FROM health_doctor_sessions x WHERE x.business_id=r.business_id AND x.resource_id=r.id),'[]') AS sessions
      FROM business_resources r JOIN health_doctor_profiles p ON p.business_id=r.business_id AND p.resource_id=r.id
      LEFT JOIN health_signatories g ON g.business_id=r.business_id AND g.resource_id=r.id AND g.kind='doctor' AND g.active
      LEFT JOIN catalog_skus cs ON cs.business_id=p.business_id AND cs.id=p.consultation_sku_id
      LEFT JOIN catalog_skus fs ON fs.business_id=p.business_id AND fs.id=p.follow_up_sku_id
      LEFT JOIN business_booking_link_people lp ON lp.link_id=$2 AND lp.resource_id=r.id
      WHERE r.business_id=$1 AND r.location_id=$3 AND r.active ORDER BY r.name,r.id`, [business.id, link.id, link.location_id]);
    // A doctor shows online with OPD timings and a fee (patients see the fee before booking).
    const people = doctors.map((d) => ({
      id: Number(d.id), name: d.name, role: d.role_label || null, speciality: d.speciality || null, qualifications: d.qualifications || null,
      registrationNo: d.registration_no || null, council: d.council || null, slotMinutes: Number(d.slot_minutes || 10),
      skuId: d.consultation_sku_id ? Number(d.consultation_sku_id) : null, feeLabel: d.fee_label || null,
      fee: d.consultation_sku_id ? shelfOf(d.fee_price, d.fee_tax_rate, taxMode) : null,
      followUpDays: Number(d.follow_up_days || 0), followUpFee: d.follow_up_price === null || d.follow_up_price === undefined ? null : shelfOf(d.follow_up_price, d.follow_up_tax_rate, taxMode),
      sessions: (d.sessions || []).map((s) => ({ dow: Number(s.dow), starts: rules.minutesOf(s.starts), ends: rules.minutesOf(s.ends), maxPatients: s.maxPatients === null ? null : Number(s.maxPatients) })),
      shown: d.shown, ready: Boolean(d.consultation_sku_id && d.fee_active && (d.sessions || []).length),
    }));
    return { kind, location, taxMode, services: [], people: all ? people : people.filter((p) => p.shown && p.ready), rooms: [] };
  }
  const services = await repo.all(db, `SELECT s.id,s.label,s.price,s.tax_rate,COALESCE(c.name,p.category) AS category,ls.minutes,COALESCE(ls.shown,false) AS shown
    FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    LEFT JOIN catalog_categories c ON c.business_id=p.business_id AND c.id=p.category_id
    LEFT JOIN business_booking_link_services ls ON ls.link_id=$2 AND ls.sku_id=s.id
    WHERE s.business_id=$1 AND s.active AND p.active AND p.kind='service' AND NOT COALESCE(s.internal_use,false) ${all ? '' : 'AND ls.shown AND ls.minutes IS NOT NULL'}
    ORDER BY COALESCE(ls.shown,false) DESC,COALESCE(c.name,p.category) NULLS LAST,s.label`, [business.id, link.id]);
  const people = await repo.all(db, `SELECT r.id,r.name,r.role_label,COALESCE(lp.shown,true) AS shown FROM business_resources r
    LEFT JOIN business_booking_link_people lp ON lp.link_id=$2 AND lp.resource_id=r.id
    WHERE r.business_id=$1 AND r.location_id=$3 AND r.active ORDER BY r.name,r.id`, [business.id, link.id, link.location_id]);
  return {
    kind, location, taxMode,
    services: services.map((s) => ({ id: Number(s.id), label: s.label, category: s.category || null, minutes: s.minutes === null ? null : Number(s.minutes),
      block: s.minutes === null ? null : Number(s.minutes), room: false, price: shelfOf(s.price, s.tax_rate, taxMode), listPrice: s.price, shown: s.shown })),
    people: keep(people.map((p) => ({ id: Number(p.id), name: p.name, role: p.role_label || null, shown: p.shown }))),
    rooms: [],
  };
}

// --- A guest's choice --------------------------------------------------------------------------------

// The services and person asked for, checked against what the link offers:
// { plan: [{ skuId, label, minutes, block, room, price }], people: [candidates], person: id | null (any), doctor }
function choose(link, shown, { serviceIds, personId }) {
  const any = personId === 'any' || personId === null || personId === undefined || personId === '';
  if (shown.kind === 'clinic') {
    if (any) fail('Choose the doctor you would like to see', 400, { field: 'person' });
    const doctor = shown.people.find((p) => p.id === Number(personId));
    if (!doctor) fail('That doctor is not taking online bookings. Please choose another, or call the clinic.', 404, { reason: 'person_not_offered' });
    return { plan: [{ skuId: doctor.skuId, label: doctor.feeLabel || 'Consultation', minutes: doctor.slotMinutes, block: doctor.slotMinutes, room: false, price: doctor.fee }],
      people: [doctor], person: doctor.id, doctor };
  }
  const ids = [...new Set((serviceIds || []).map(Number))];
  const most = shown.kind === 'salon' ? 3 : 1;
  if (!ids.length) fail('Choose a service', 400, { field: 'services' });
  if (ids.length > most) fail(most === 1 ? 'Choose one service' : 'Choose up to three services for one visit', 400, { field: 'services' });
  const plan = ids.map((id) => {
    const service = shown.services.find((s) => s.id === id);
    if (!service) fail('That service is not booked online. Please choose another, or call us.', 404, { reason: 'service_not_offered' });
    return { skuId: service.id, label: service.label, minutes: service.minutes, block: service.block, room: service.room, price: service.price };
  });
  // A stylist who does every service chosen (no skills set: every service).
  const able = shown.people.filter((p) => !p.skills || !p.skills.length || plan.every((step) => p.skills.includes(step.skuId)));
  if (any) {
    if (!link.allow_any_staff && shown.people.length > 1) fail('Choose who you would like', 400, { field: 'person' });
    if (!able.length) fail('Nobody here does all of those together. Please book them separately, or call us.', 409, { reason: 'nobody_able' });
    return { plan, people: able, person: null };
  }
  const person = shown.people.find((p) => p.id === Number(personId));
  if (!person) fail('That person is not taking online bookings. Please choose another, or call us.', 404, { reason: 'person_not_offered' });
  if (!able.includes(person)) fail(`${person.name} does not do ${plan.map((s) => s.label).join(' and ')}. Please choose someone else.`, 409, { reason: 'person_cannot' });
  return { plan, people: [person], person: person.id };
}

// --- What is taken, on the days asked ----------------------------------------------------------------

// The time each person and room is held on [from, to] (business days), the
// people's leave, the salon's holidays, and each doctor's online bookings per
// session. `except`: a booking's own appointments (a guest changing its time).
async function taken(db, business, link, shown, people, { from, to, except = [] }) {
  const tz = business.timezone || 'Asia/Kolkata';
  const startMs = rules.instantOf(from, 0, tz), endMs = rules.instantOf(rules.addDays(to, 1), 0, tz);
  const ids = people.map((p) => p.id), roomIds = shown.rooms.map((r) => r.id);
  const rows = await repo.all(db, `SELECT a.id,a.resource_id,a.starts_at,a.ends_at,a.source,d.room_id,(a.starts_at AT TIME ZONE $6)::date::text AS day
    FROM business_appointments a LEFT JOIN salon_appointment_details d ON d.business_id=a.business_id AND d.appointment_id=a.id
    WHERE a.business_id=$1 AND business_appointment_holds(a.status,a.request_expires_at) AND a.starts_at<$3 AND a.ends_at>$2
      AND NOT (a.id=ANY($7::bigint[])) AND (a.resource_id=ANY($4::bigint[]) OR d.room_id=ANY($5::bigint[]))`,
  [business.id, new Date(startMs), new Date(endMs), ids, roomIds, tz, except]);
  const busy = new Map(), rooms = new Map(), load = new Map(), online = new Map();
  for (const row of rows) {
    const span = [new Date(row.starts_at).getTime(), new Date(row.ends_at).getTime()];
    const person = String(row.resource_id);
    if (!busy.has(person)) busy.set(person, []);
    busy.get(person).push(span);
    load.set(`${person}|${row.day}`, (load.get(`${person}|${row.day}`) || 0) + 1);
    if (row.room_id) {
      if (!rooms.has(String(row.room_id))) rooms.set(String(row.room_id), []);
      rooms.get(String(row.room_id)).push(span);
    }
    if (row.source === 'guests_site') {
      const key = `${person}|${row.day}`;
      if (!online.has(key)) online.set(key, []);
      online.get(key).push(rules.clockOf(tz, span[0]).minutes);
    }
  }
  const leave = new Map(), holidays = new Set();
  if (shown.kind === 'salon') {
    for (const row of await repo.all(db, `SELECT resource_id,from_date::text AS from,to_date::text AS to FROM salon_staff_leave
      WHERE business_id=$1 AND resource_id=ANY($2::bigint[]) AND cancelled_at IS NULL AND to_date>=$3::date AND from_date<=$4::date`, [business.id, ids, from, to])) {
      if (!leave.has(String(row.resource_id))) leave.set(String(row.resource_id), []);
      leave.get(String(row.resource_id)).push({ from: row.from, to: row.to });
    }
    for (const row of await repo.all(db, `SELECT day::text AS day FROM salon_holidays WHERE business_id=$1 AND cancelled_at IS NULL AND (location_id IS NULL OR location_id=$2)
      AND day BETWEEN $3::date AND $4::date`, [business.id, link.location_id, from, to])) holidays.add(row.day);
  }
  if (shown.kind === 'clinic') {
    for (const row of await repo.all(db, `SELECT resource_id,from_date::text AS from,to_date::text AS to FROM health_doctor_leave
      WHERE business_id=$1 AND resource_id=ANY($2::bigint[]) AND cancelled_at IS NULL AND to_date>=$3::date AND from_date<=$4::date`, [business.id, ids, from, to])) {
      if (!leave.has(String(row.resource_id))) leave.set(String(row.resource_id), []);
      leave.get(String(row.resource_id)).push({ from: row.from, to: row.to });
    }
  }
  return { busy, rooms, load, online, leave, holidays };
}

// --- Free times on one day ---------------------------------------------------------------------------

const onLeave = (list, date) => (list || []).some((l) => l.from <= date && date <= l.to);

// The free times of a day for a choice: [{ minutes, startsMs, endsMs, people: [{ id, rooms }] }],
// with why the day has none when it is closed.
function dayTimes(business, link, shown, choice, held, date, clock) {
  const tz = business.timezone || 'Asia/Kolkata';
  const toMs = rules.dayClock(date, tz);
  const earliestMs = clock.nowMs + Number(link.min_notice_minutes) * 60000;
  const total = choice.plan.reduce((sum, step) => sum + step.block, 0);
  const people = (list) => list.map((p) => ({ ...p, busy: held.busy.get(String(p.id)) || [], load: held.load.get(`${p.id}|${date}`) || 0 }));
  if (shown.kind === 'salon') {
    const salon = { opens: shown.salon.opens, closes: shown.salon.closes, holidays: held.holidays };
    if (held.holidays.has(date)) return { open: false, reason: 'closed', times: [] };
    const working = people(choice.people).map((p) => ({ ...p, window: rules.stylistWindow({ ...p, leave: held.leave.get(String(p.id)) }, date, salon) }));
    if (!working.some((p) => p.window)) return { open: false, reason: choice.person ? 'away' : 'closed', times: [] };
    const rooms = shown.rooms.map((r) => ({ id: r.id, busy: held.rooms.get(String(r.id)) || [] }));
    const times = rules.freeTimes({ candidates: rules.grid(salon.opens, salon.closes, Number(link.slot_step_minutes), total),
      plan: choice.plan.map((step) => ({ minutes: step.block, room: step.room })), people: working, rooms, toMs, earliestMs });
    return { open: true, times, people: working };
  }
  if (shown.kind === 'clinic') {
    const doctor = choice.people[0];
    const dow = rules.weekdayOf(date);
    const sessions = doctor.sessions.filter((s) => s.dow === dow);
    if (!sessions.length) return { open: false, reason: 'no_opd', times: [] };
    if (onLeave(held.leave.get(String(doctor.id)), date)) return { open: false, reason: 'away', times: [] };
    const share = Number(link.online_share_percent) / 100;
    const online = held.online.get(`${doctor.id}|${date}`) || [];
    const today = date === clock.date;
    const all = [];
    let started = 0;
    for (const session of sessions) {
      // Online booking for a session closes when it starts: the rest is for walk-ins.
      if (today && clock.minutes >= session.starts) { started += 1; continue; }
      const slots = rules.grid(session.starts, session.ends, doctor.slotMinutes, doctor.slotMinutes);
      const cap = Math.floor((session.maxPatients ?? slots.length) * share);
      const booked = online.filter((m) => m >= session.starts && m < session.ends).length;
      if (booked >= cap) continue;
      const [one] = people([doctor]);
      all.push(...rules.freeTimes({ candidates: slots, plan: [{ minutes: doctor.slotMinutes, room: false }],
        people: [{ ...one, window: [session.starts, session.ends] }], toMs, earliestMs }));
    }
    return { open: true, times: all.sort((a, b) => a.minutes - b.minutes), people: people([doctor]), reason: started === sessions.length ? 'started' : 'full' };
  }
  const window = rules.locationWindow(shown.location && shown.location.opening_hours, date);
  if (!window) return { open: false, reason: 'closed', times: [] };
  const working = people(choice.people).map((p) => ({ ...p, window }));
  const times = rules.freeTimes({ candidates: rules.grid(window[0], window[1], Number(link.slot_step_minutes), total),
    plan: choice.plan.map((step) => ({ minutes: step.block, room: false })), people: working, toMs, earliestMs });
  return { open: true, times, people: working };
}

// Each day of [from, to] with its free times.
async function daysFor(db, business, link, shown, choice, { from, to, except = [] }, clock) {
  const held = await taken(db, business, link, shown, choice.people, { from, to, except });
  const days = [];
  for (let date = from; date <= to; date = rules.addDays(date, 1)) {
    days.push({ date, ...dayTimes(business, link, shown, choice, held, date, clock) });
  }
  return days;
}

// The next free times from a moment on (a time just taken: what to offer instead).
async function nextFree(db, business, link, shown, choice, { fromDate, afterMinutes = -1, lastDate, except = [] }, clock, count = 3) {
  const days = await daysFor(db, business, link, shown, choice, { from: fromDate, to: lastDate, except }, clock);
  const next = [];
  for (const day of days) {
    for (const t of day.times) {
      if (day.date === fromDate && t.minutes <= afterMinutes) continue;
      next.push({ date: day.date, time: rules.timeText(t.minutes), label: `${rules.dateLabel(day.date)}, ${rules.timeLabel(t.minutes)}` });
      if (next.length >= count) return next;
    }
  }
  return next;
}

module.exports = { kindOf, offer, choose, taken, dayTimes, daysFor, nextFree, shelfOf };
