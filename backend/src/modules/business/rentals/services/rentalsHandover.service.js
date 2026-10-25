const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const licences = require('../../licences/services/businessLicences.service');
const c = require('./rentalsCommon');
const money = require('./rentalsMoney');
const bookings = require('./rentalsBookings.service');
const pins = () => require('../../salon-weight/services/businessManagerPin');

// The handover and the return (module "rentals").
//
//   handover  a reserved booking goes out once its out time has come: every
//             unit in service; for each line what was noted about it, and for
//             a unit with a meter its reading (never less than its last) and
//             for a vehicle its fuel; the hirer's photo ID (of an Aadhaar card
//             only the last four digits are kept); for a self-drive vehicle
//             the driving licence number and its expiry (refused once it has
//             run out) and the State Transport Authority's rent-a-cab or
//             rent-a-motorcycle licence of the location, in force (Settings ›
//             Licences); the refundable deposit asked, taken now or before (a
//             collection receipt, no GST), or less with a manager's say-so.
//   return    things come back, all at once or in parts (a pool by how many,
//             with those that will not come back reported missing): what was
//             noted, the meter and fuel, a unit sent for maintenance; how late
//             each is and its late fee (within the grace time nothing; after it
//             every hour or day or part of one since it was due, at the booked
//             late rate); damage, missing, cleaning, fuel and other charges.
//   the bill  when the last of it is back: one core sale of the hire (each
//             line at its booked price, GST at its item's rate of the day), the
//             late fees and the charges, each at its item's slab. What is
//             taken now pays first, then the advances, then the deposits: a
//             deposit becomes part of the payment when it pays the bill, so
//             whatever the shop keeps of it is billed with its GST. What is
//             left of the deposit goes back now (a manager's PIN) or later.
// Money is integer paise.

const { fail, id } = c;
const MAX_CHARGE = 10000000;
const unitName = (line) => line.unit_label || line.item_name;
const meterName = (line) => (line.meter === 'km' ? 'odometer' : 'hour meter');

// The lines of a booking with what came back of each, their item's rules now and their unit as it is.
async function linesOf(db, business, booking) {
  return repo.all(db, `SELECT l.*,i.kind,i.vehicle,i.with_driver,i.meter,i.pool_quantity,s.tax_rate AS tax_rate_now,u.status AS unit_status,u.status_note AS unit_status_note,
      u.meter_reading AS unit_meter,COALESCE(x.back,0)::int AS back,COALESCE(x.missing,0)::int AS missing
    FROM rental_booking_lines l JOIN rental_items i ON i.business_id=l.business_id AND i.id=l.item_id JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
    LEFT JOIN rental_units u ON u.business_id=l.business_id AND u.id=l.unit_id
    LEFT JOIN LATERAL (SELECT sum(rl.quantity) AS back,sum(rl.missing) AS missing FROM rental_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id) x ON TRUE
    WHERE l.business_id=$1 AND l.booking_id=$2 ORDER BY l.seq`, [business.id, booking.id]);
}

// --- The handover ----------------------------------------------------------------------------------

// What is noted of each line at the handover: [{ lineId, note?, meter?, fuel? }].
function readOutFacts(value) {
  if (value === undefined || value === null) return [];
  const list = v.requiredArray(value, 'What was noted');
  return list.map((raw, index) => {
    const name = `Line ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
    return { lineId: id(raw.lineId, `${name}: line`), note: c.optionalText(raw.note, `${name}: condition noted`, 300),
      meter: c.given(raw.meter) ? c.readMeter(raw.meter, `${name}: meter reading`) : null,
      fuel: c.given(raw.fuel) ? v.requiredEnum(raw.fuel, `${name}: fuel`, c.FUEL_LEVELS) : null };
  });
}

// body: { requestKey, idKind?, idRef?, licenceNo?, licenceValidUntil?, lines?: [{ lineId, note?, meter?, fuel? }],
//   deposit?: { amount, method | methodId, reference? }, waiver?: { reason, approverId?, pin? } (less deposit than asked), note? }
async function checkout(business, user, bookingId, body) {
  c.requireRentals(business);
  await access.require(business, 'rentals.edit');
  const requestKey = core.uuid(body.requestKey);
  // The PIN is checked, never kept, not even in the hash.
  const hash = c.hashOf({ ...body, waiver: body.waiver ? { reason: body.waiver.reason, approverId: body.waiver.approverId } : undefined, bookingId: String(bookingId) });
  const facts = readOutFacts(body.lines);
  const hirer = c.given(body.idKind) || c.given(body.idRef) ? c.readId(body.idKind, body.idRef) : null;
  const licence = c.given(body.licenceNo) || c.given(body.licenceValidUntil)
    ? { no: c.readLicence(body.licenceNo), validUntil: c.readDate(body.licenceValidUntil, 'Driving licence valid until') } : null;
  const note = c.optionalText(body.note, 'Note', 500);
  // A manager's say-so to take less deposit: read before the transaction (a PIN check holds no locks).
  const waiver = body.waiver && c.given(body.waiver.reason)
    ? await pins().readApproval(business, user, body.waiver, 'rentals.approve', { reasonLabel: 'Why less deposit is taken', selfWithoutPin: true }) : null;
  return repo.transaction(async (db) => {
    const booking = await bookings.lockBooking(db, business, bookingId);
    if (booking.checkout_key) {
      if (booking.checkout_key !== requestKey || booking.checkout_hash !== hash) fail(`Booking ${booking.booking_no} is handed over already`, 409);
      return bookings.shape(business, await bookings.load(db, business, booking.id));
    }
    if (booking.status === 'quote') fail(`${booking.booking_no} is a quote: reserve it first`, 409);
    if (booking.status !== 'reserved') fail(`Booking ${booking.booking_no} is ${booking.status}: only a reserved booking is handed over`, 409);
    const clock = await repo.one(db, 'SELECT now() AS now,(now() AT TIME ZONE $1)::date::text AS today', [business.timezone || 'Asia/Kolkata']);
    if (booking.out_at > clock.now) fail(`Booking ${booking.booking_no} goes out at ${c.timeWords(booking.out_at, business.timezone)}: change its times to hand it over now`, 409);
    if (booking.due_at <= clock.now) fail(`Booking ${booking.booking_no} was due back at ${c.timeWords(booking.due_at, business.timezone)}: change its times first`, 409);
    const lines = await linesOf(db, business, booking);
    for (const fact of facts) if (!lines.some((l) => Number(l.id) === fact.lineId)) fail(`That line is not on booking ${booking.booking_no}`, 404);
    const factOf = (line) => facts.find((f) => f.lineId === Number(line.id)) || { note: null, meter: null, fuel: null };
    for (const line of lines) {
      const fact = factOf(line);
      if (line.unit_id && line.unit_status !== 'available') {
        fail(`${line.unit_label} is ${line.unit_status === 'maintenance' ? 'in maintenance' : 'retired'}${line.unit_status_note ? ` (${line.unit_status_note})` : ''}: put it back in service, or change the booking to another unit`, 409);
      }
      if (line.unit_id && line.meter) {
        if (fact.meter === null) fail(`Read ${line.unit_label}'s ${meterName(line)} as it goes out`);
        if (line.unit_meter !== null && fact.meter < Number(line.unit_meter)) fail(`${line.unit_label}'s ${meterName(line)} read ${Number(line.unit_meter)} last: a reading never goes back`, 409);
      } else if (fact.meter !== null) fail(`${unitName(line)} has no meter to read`);
      if (line.vehicle && !fact.fuel) fail(`Note ${line.unit_label}'s fuel as it goes out`);
      if (!line.vehicle && fact.fuel) fail(`${unitName(line)} is not a vehicle: it has no fuel to note`);
    }
    // A self-drive vehicle: the hirer's driving licence in force, and the location's licence to hire it out.
    const selfDrive = lines.filter((l) => l.vehicle && !l.with_driver);
    if (selfDrive.length) {
      if (!licence) fail('A self-drive vehicle goes out on the hirer\'s driving licence: give its number and the date it is valid until');
      if (licence.validUntil < clock.today) fail(`The driving licence ${licence.no} ran out on ${c.dateWords(licence.validUntil)}: a vehicle is not handed over on it`, 409);
      const location = await repo.one(db, 'SELECT name FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, booking.location_id]);
      for (const kind of [...new Set(selfDrive.map((l) => l.vehicle))]) {
        const need = c.SELF_DRIVE_LICENCES[kind];
        if (!need) continue;
        const words = `the State Transport Authority's ${need.words}`;
        if (!business.modules.includes('licences')) {
          fail(`Self-drive hire of a ${c.VEHICLE_WORDS[kind]} needs ${words}: switch on Licences & registrations in Settings › Business tools, and add it under Settings › Licences`, 409);
        }
        const held = await licences.standing(db, business, { locationId: booking.location_id, kind: need.kind, on: clock.today });
        if (!held?.in_force) fail(`Self-drive hire of a ${c.VEHICLE_WORDS[kind]} needs ${words}, and ${licences.whyNot(held, need.words, location.name)}. Add or renew it under Settings › Licences.`, 409);
      }
    }
    const settings = await c.settingsOf(db, business.id);
    if (settings.id_required && !hirer) fail('Record the hirer\'s photo ID, its kind and number (of an Aadhaar card, only its last four digits)');
    // The deposit asked: taken now (a receipt, no GST) or before; less only with a manager's say-so.
    const deposit = await bookings.readMoney(db, business, body.deposit, 'Deposit');
    if (deposit) await bookings.takeReceipt(db, business, user, booking, { purpose: 'deposit', ...deposit, requestKey: c.derivedKey(requestKey, 'deposit'), hash });
    const held = money.paise((await repo.one(db, 'SELECT rental_deposit_held($1,$2) AS held', [business.id, booking.id])).held);
    const asked = money.paise(booking.deposit_due);
    const short = held < asked;
    if (short && !waiver) {
      fail(`Booking ${booking.booking_no} asks a deposit of ${money.rupees(asked)}; ${money.rupees(held)} is held. Take the rest, or have a manager agree to less.`, 409,
        { reason: 'deposit_short', asked: money.rupees(asked), held: money.rupees(held) });
    }
    await db.query(`UPDATE rental_bookings SET status='out',checked_out_at=now(),checked_out_by=$3,checkout_key=$4,checkout_hash=$5,id_kind=$6,id_ref=$7,licence_no=$8,
        licence_valid_until=$9,deposit_waived_by=$10,deposit_waiver=$11,updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2`,
    [business.id, booking.id, user.id, requestKey, hash, hirer?.idKind || null, hirer?.idRef || null, licence?.no || null, licence?.validUntil || null,
      short ? waiver.approver.id : null, short ? waiver.reason : null]);
    for (const line of lines) {
      const fact = factOf(line);
      if (fact.note || fact.meter !== null || fact.fuel) {
        await db.query('UPDATE rental_booking_lines SET out_note=$3,meter_out=$4,fuel_out=$5 WHERE business_id=$1 AND id=$2', [business.id, line.id, fact.note, fact.meter, fact.fuel]);
      }
      if (line.unit_id && fact.meter !== null) {
        await db.query('UPDATE rental_units SET meter_reading=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, line.unit_id, fact.meter, user.id]);
      }
    }
    const idWords = hirer ? `${c.ID_KINDS[hirer.idKind]} ${hirer.idKind === 'aadhaar' ? `ending ${hirer.idRef}` : hirer.idRef}` : null;
    await bookings.history(db, business, user, booking, 'reserved', 'out', ['Handed over', idWords, licence ? `driving licence ${licence.no}, valid until ${c.dateWords(licence.validUntil)}` : null,
      asked ? `deposit ${money.rupees(held)} held${short ? ` (${money.rupees(asked)} asked; ${waiver.approver.name} agreed: ${waiver.reason})` : ''}` : null, note].filter(Boolean).join(' · '));
    const details = { bookingNo: booking.booking_no, idKind: hirer?.idKind || null, licenceNo: licence?.no || null, depositAsked: money.rupees(asked), depositHeld: money.rupees(held),
      ...(short ? { depositAgreedBy: waiver.approver.name, why: waiver.reason } : {}), meters: lines.filter((l) => factOf(l).meter !== null).map((l) => ({ unit: l.unit_label, reading: factOf(l).meter })) };
    await repo.audit(db, business.id, user.id, 'rental_booking.checked_out', booking.id, details);
    await repo.event(db, business.id, user.id, 'rental_booking.checked_out', 'rental_booking', booking.id, { ...details, dueAt: booking.due_at });
    return bookings.shape(business, await bookings.load(db, business, booking.id));
  });
}

// --- The return ------------------------------------------------------------------------------------

// What comes back as typed: [{ lineId, quantity?, missing?, note?, meter?, fuel?, maintenance? }] and the charges [{ lineId, kind, amount, note? }].
function readReturn(body) {
  const list = v.requiredArray(body.lines, 'What came back');
  const lines = list.map((raw, index) => {
    const name = `Line ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
    return { lineId: id(raw.lineId, `${name}: line`), quantity: c.given(raw.quantity) ? c.whole(raw.quantity, `${name}: how many came back`, 0, 1000000) : null,
      missing: c.given(raw.missing) ? c.whole(raw.missing, `${name}: how many will not come back`, 0, 1000000) : 0,
      note: c.optionalText(raw.note, `${name}: condition noted`, 300), meter: c.given(raw.meter) ? c.readMeter(raw.meter, `${name}: meter reading`) : null,
      fuel: c.given(raw.fuel) ? v.requiredEnum(raw.fuel, `${name}: fuel`, c.FUEL_LEVELS) : null, maintenance: v.requiredBoolean(raw.maintenance, `${name}: for maintenance`, false) };
  });
  if (new Set(lines.map((l) => l.lineId)).size !== lines.length) fail('Each line is named once');
  const charges = (body.charges === undefined || body.charges === null ? [] : v.requiredArray(body.charges, 'Charges')).map((raw, index) => {
    const name = `Charge ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
    const kind = v.requiredEnum(raw.kind, `${name}: for`, c.CHARGE_KINDS);
    const charge = { lineId: id(raw.lineId, `${name}: line`), kind, amount: money.paise(core.decimal(raw.amount, `${name}: amount`, 2, 0.01, MAX_CHARGE)),
      note: c.optionalText(raw.note, `${name}: what it is for`, 300) };
    if (['damage', 'other'].includes(kind) && !charge.note) fail(`${name}: say what the ${kind === 'damage' ? 'damage is' : 'charge is for'}`);
    return charge;
  });
  if (charges.length > 50) fail('Note at most 50 charges at once');
  return { lines, charges, note: c.optionalText(body.note, 'Note', 500) };
}

// The return worked out, nothing written: each line back with its lateness and
// late fee; whether it is the last of the booking; and then the bill's values
// (the hire, every late fee and every charge), its figures, and what the
// advances and deposits pay and what is left of the deposit.
async function planReturn(db, business, booking, input) {
  const lines = await linesOf(db, business, booking);
  const clock = await repo.one(db, 'SELECT now() AS now,GREATEST(0,floor(EXTRACT(EPOCH FROM (now()-$1::timestamptz))/60))::int AS minutes', [booking.due_at]);
  const back = input.lines.map((raw) => {
    const line = lines.find((l) => Number(l.id) === raw.lineId);
    if (!line) fail(`That line is not on booking ${booking.booking_no}`, 404);
    const left = Number(line.quantity) - Number(line.back) - Number(line.missing);
    const quantity = raw.quantity === null ? (line.unit_id ? (raw.missing ? 0 : left) : left - raw.missing) : raw.quantity;
    if (quantity < 0 || quantity + raw.missing > left) fail(`${left} of ${unitName(line)} ${left === 1 ? 'is' : 'are'} still out on booking ${booking.booking_no}`, 409);
    if (quantity + raw.missing === 0) return null;
    if (line.unit_id && quantity === 1) {
      if (line.meter && raw.meter === null) fail(`Read ${line.unit_label}'s ${meterName(line)} as it comes back`);
      if (line.meter && line.meter_out !== null && raw.meter < Number(line.meter_out)) fail(`${line.unit_label} went out reading ${Number(line.meter_out)}: it cannot come back reading less`, 409);
      if (line.vehicle && !raw.fuel) fail(`Note ${line.unit_label}'s fuel as it comes back`);
    }
    if (!line.meter && raw.meter !== null) fail(`${unitName(line)} has no meter to read`);
    if (raw.maintenance && !line.unit_id) fail(`${line.item_name} is a pool: report what will not come back as missing, and lower the pool for what is out of use`);
    if (raw.maintenance && quantity !== 1) fail(`${unitName(line)} goes for maintenance once it is back`);
    const late = money.lateFee({ minutes: clock.minutes, grace: line.grace_minutes, per: line.late_per, rate: line.late_rate, quantity });
    return { line, quantity, missing: raw.missing, note: raw.note, meter: line.unit_id && quantity === 1 ? raw.meter : null, fuel: line.vehicle && quantity === 1 ? raw.fuel : null,
      maintenance: raw.maintenance, minutes: clock.minutes, late };
  }).filter(Boolean);
  if (!back.length) fail('Say what came back: how many of each, or what will not come back');
  for (const charge of input.charges) {
    if (!lines.some((l) => Number(l.id) === charge.lineId)) fail(`That line is not on booking ${booking.booking_no}`, 404);
  }
  const outLeft = lines.reduce((s, l) => s + Number(l.quantity) - Number(l.back) - Number(l.missing), 0);
  const final = back.reduce((s, b) => s + b.quantity + b.missing, 0) === outLeft;
  const plan = { lines, back, charges: input.charges, final, minutes: clock.minutes, lateFee: back.reduce((s, b) => s + b.late.fee, 0) };
  if (!final) return plan;
  // The bill: the hire, the late fees (earlier returns' and this one's) and the charges (earlier and now), each one line.
  const earlierLate = await repo.all(db, `SELECT rl.return_id,rl.line_id,rl.quantity,rl.late_units,rl.late_fee FROM rental_return_lines rl
    WHERE rl.business_id=$1 AND rl.booking_id=$2 AND rl.late_fee>0 ORDER BY rl.return_id,rl.line_id`, [business.id, booking.id]);
  const earlierCharges = await repo.all(db, 'SELECT id,booking_line_id,kind,amount,note FROM rental_charges WHERE business_id=$1 AND booking_id=$2 AND line_id IS NULL ORDER BY id',
    [business.id, booking.id]);
  const lineOf = (lineId) => lines.find((l) => Number(l.id) === Number(lineId));
  const values = [
    ...lines.map((line) => ({ ref: { kind: 'hire', line }, ...bookings.billValue(booking, line, { amount: money.paise(line.amount), quantity: Number(line.quantity),
      words: `Hire for ${money.periodWords(line)}` }) })),
    ...earlierLate.map((rl) => ({ ref: { kind: 'late_earlier', rl }, ...bookings.billValue(booking, lineOf(rl.line_id), { amount: money.paise(rl.late_fee), quantity: Number(rl.quantity),
      words: `Late return, ${money.lateWords(Number(rl.late_units), lineOf(rl.line_id).late_per)}` }) })),
    ...back.filter((b) => b.late.fee > 0).map((b) => ({ ref: { kind: 'late', back: b }, ...bookings.billValue(booking, b.line, { amount: b.late.fee, quantity: b.quantity,
      words: `Late return, ${money.lateWords(b.late.units, b.line.late_per)}` }) })),
    ...earlierCharges.map((ch) => ({ ref: { kind: 'charge_earlier', charge: ch }, ...bookings.billValue(booking, lineOf(ch.booking_line_id), { amount: money.paise(ch.amount),
      words: [c.CHARGE_WORDS[ch.kind], ch.note].filter(Boolean).join(' · ') }) })),
    ...input.charges.map((ch) => ({ ref: { kind: 'charge', charge: ch }, ...bookings.billValue(booking, lineOf(ch.lineId), { amount: ch.amount,
      words: [c.CHARGE_WORDS[ch.kind], ch.note].filter(Boolean).join(' · ') }) })),
  ];
  const settings = await repo.one(db, 'SELECT rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const figures = money.billFigures(values, settings?.rounding);
  const receipts = await bookings.receiptsOf(db, business, booking.id);
  const free = (purpose) => receipts.filter((r) => r.purpose === purpose).reduce((s, r) => s + Math.max(0, money.paise(r.free)), 0);
  const advance = Math.min(free('advance'), figures.total);
  const deposit = Math.min(free('deposit'), figures.total - advance);
  return { ...plan, values, figures, advance, deposit, due: figures.total - advance - deposit, depositBack: free('deposit') - deposit,
    advanceBack: free('advance') - advance };
}

const planText = (plan, booking) => ({
  final: plan.final, lateMinutes: plan.minutes, lateFee: money.rupees(plan.lateFee),
  lines: plan.back.map((b) => ({ lineId: b.line.id, itemName: b.line.item_name, unitLabel: b.line.unit_label, quantity: b.quantity, missing: b.missing, lateUnits: b.late.units,
    latePer: b.line.late_per, lateFee: money.rupees(b.late.fee) })),
  ...(plan.final ? {
    ...money.figuresText(plan.figures), advance: money.rupees(plan.advance), deposit: money.rupees(plan.deposit), due: money.rupees(plan.due),
    depositBack: money.rupees(plan.depositBack), advanceBack: money.rupees(plan.advanceBack),
    bill: plan.values.map((x) => ({ label: x.label, quantity: x.quantity, net: money.rupees(x.net), tax: money.rupees(x.tax) })),
  } : {}),
  bookingNo: booking.booking_no,
});

// The figures of a return being typed, nothing saved (the return screen).
async function preview(business, user, bookingId, body) {
  c.requireRentals(business);
  await access.require(business, 'rentals.edit');
  const input = readReturn(body);
  // Nothing is locked: a preview never waits for a posting.
  return repo.transaction(async (db) => {
    const booking = await repo.one(db, 'SELECT * FROM rental_bookings WHERE business_id=$1 AND id=$2', [business.id, id(bookingId, 'Booking')]);
    if (!booking) fail('Booking not found', 404);
    access.requireLocation(business, booking.location_id);
    if (booking.status !== 'out') fail(`Booking ${booking.booking_no} is ${booking.status}: things come back on a booking that is out`, 409);
    const text = planText(await planReturn(db, business, booking, input), booking);
    return c.seesMoney(business) ? text : { final: text.final, lateMinutes: text.lateMinutes, lines: text.lines.map((l) => ({ ...l, lateFee: null })), bookingNo: text.bookingNo };
  });
}

// body: { requestKey, lines: [{ lineId, quantity?, missing?, note?, meter?, fuel?, maintenance? }], charges?: [{ lineId, kind, amount, note? }], note?,
//   payment? | payments? (the rest of the bill, with the last of it back), refund?: { method | methodId, reference? } (the deposit left, handed back),
//   approval?: { approverId?, pin?, reason? } (with a refund), buyer?: { pan?, panDeclaration? } }
async function takeBack(business, user, bookingId, body) {
  c.requireRentals(business);
  await access.require(business, 'rentals.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, approval: undefined, bookingId: String(bookingId) });
  const input = readReturn(body);
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  const how = body.refund ? bookings.readBack(body.refund) : null;
  if (how) await access.require(business, 'rentals.refund');
  // A manager's PIN for money handed back, checked before the transaction (a PIN check holds no locks).
  const approval = how ? await pins().readApproval(business, user, { ...(body.approval || {}),
    reason: c.given(body.approval?.reason) ? body.approval.reason : 'Deposit handed back at the return' }, 'rentals.refund', { reasonLabel: 'Reason' }) : null;
  return repo.transaction(async (db) => {
    const booking = await bookings.lockBooking(db, business, bookingId);
    // A retry gives the same return; the same key with other data is refused.
    const done = await repo.one(db, 'SELECT id,booking_id,request_hash FROM rental_returns WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash || Number(done.booking_id) !== Number(booking.id)) fail('This request key was already used for different data', 409);
      return bookings.shape(business, await bookings.load(db, business, booking.id));
    }
    if (booking.status !== 'out') fail(`Booking ${booking.booking_no} is ${booking.status}: things come back on a booking that is out`, 409);
    const plan = await planReturn(db, business, booking, input);
    if (!plan.final && (parts.length || how)) fail('The bill is made, and the deposit handed back, when the last of the booking is back');
    let bill = null;
    if (plan.final) {
      await access.require(business, 'sales.create');
      bill = await bookings.postBill(db, business, user, booking, { values: plan.values.map(({ ref: _ref, ...value }) => value), parts, buyer: body.buyer, key: requestKey, hash });
    }
    const lineIdOf = (match) => (bill ? bill.lineIds[plan.values.findIndex(match)] ?? null : null);
    const ret = await repo.one(db, 'INSERT INTO rental_returns(business_id,booking_id,final,document_id,note,request_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [business.id, booking.id, plan.final, bill?.document.id || null, input.note, requestKey, hash, user.id]);
    for (const b of plan.back) {
      await db.query(`INSERT INTO rental_return_lines(business_id,return_id,booking_id,line_id,quantity,missing,note,meter_in,fuel_in,late_minutes,late_units,late_fee,late_line_id,maintenance)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [business.id, ret.id, booking.id, b.line.id, b.quantity, b.missing, b.note, b.meter, b.fuel, b.minutes, b.late.units,
        money.rupees(b.late.fee), b.late.fee > 0 ? lineIdOf((x) => x.ref.kind === 'late' && x.ref.back === b) : null, b.maintenance]);
      if (b.line.unit_id) {
        const unitNote = b.missing ? `Not returned on ${booking.booking_no}${b.note ? `: ${b.note}` : ''}` : b.maintenance ? (b.note || `After ${booking.booking_no}`) : null;
        await db.query(`UPDATE rental_units SET meter_reading=COALESCE($3,meter_reading),status=CASE WHEN $4::text IS NULL THEN status ELSE $4 END,
            status_note=CASE WHEN $4::text IS NULL THEN status_note ELSE $5 END,updated_by=$6,updated_at=now() WHERE business_id=$1 AND id=$2`,
        [business.id, b.line.unit_id, b.meter, b.missing ? 'retired' : b.maintenance ? 'maintenance' : null, unitNote ? unitNote.slice(0, 300) : null, user.id]);
      } else if (b.missing) {
        // What will not come back leaves the pool.
        const item = await repo.one(db, 'UPDATE rental_items SET pool_quantity=GREATEST(0,pool_quantity-$3),updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING pool_quantity',
          [business.id, b.line.item_id, b.missing, user.id]);
        await repo.audit(db, business.id, user.id, 'rental_item.pool_changed', b.line.item_id, { name: b.line.item_name, missing: b.missing, bookingNo: booking.booking_no, poolNow: item.pool_quantity });
      }
    }
    for (const charge of plan.charges) {
      await db.query('INSERT INTO rental_charges(business_id,booking_id,return_id,booking_line_id,kind,amount,note,line_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [business.id, booking.id, ret.id, charge.lineId, charge.kind, money.rupees(charge.amount), charge.note, lineIdOf((x) => x.ref.kind === 'charge' && x.ref.charge === charge), user.id]);
    }
    let back = [];
    if (plan.final) {
      for (const x of plan.values) {
        const lineId = lineIdOf((y) => y === x);
        if (x.ref.kind === 'hire') await db.query('UPDATE rental_booking_lines SET line_id=$3 WHERE business_id=$1 AND id=$2', [business.id, x.ref.line.id, lineId]);
        if (x.ref.kind === 'late_earlier') {
          await db.query('UPDATE rental_return_lines SET late_line_id=$4 WHERE business_id=$1 AND return_id=$2 AND line_id=$3', [business.id, x.ref.rl.return_id, x.ref.rl.line_id, lineId]);
        }
        if (x.ref.kind === 'charge_earlier') await db.query('UPDATE rental_charges SET line_id=$3 WHERE business_id=$1 AND id=$2', [business.id, x.ref.charge.id, lineId]);
      }
      await db.query(`UPDATE rental_bookings SET status='returned',returned_at=now(),document_id=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2`,
        [business.id, booking.id, bill.document.id, user.id]);
      if (how) back = await bookings.refundLeft(db, business, user, booking, { purposes: ['deposit', 'advance'], how, approval, key: requestKey });
    }
    const words = plan.back.map((b) => [b.quantity ? `${b.line.unit_id ? b.line.unit_label : `${b.quantity} × ${b.line.item_name}`} back` : null,
      b.missing ? `${b.line.unit_id ? b.line.unit_label : `${b.missing} × ${b.line.item_name}`} missing` : null, b.late.units ? `${money.lateWords(b.late.units, b.line.late_per)} late` : null,
      b.maintenance ? 'for maintenance' : null].filter(Boolean).join(', '));
    const refunded = back.reduce((s, r) => s + money.paise(r.amount), 0);
    await bookings.history(db, business, user, booking, plan.final ? 'out' : null, plan.final ? 'returned' : null, [`Back: ${words.join('; ')}`,
      plan.charges.length ? `${c.plural(plan.charges.length, 'charge')} noted` : null, bill ? `billed (${bill.document.document_no})` : null,
      bill && bill.used.deposit ? 'the deposit applied to the bill' : null, refunded ? `${money.rupees(refunded)} handed back (${back.map((r) => r.refund_no).join(', ')})` : null,
      input.note].filter(Boolean).join(' · '));
    const details = { bookingNo: booking.booking_no, final: plan.final, lateFee: money.rupees(plan.lateFee), charges: plan.charges.map((x) => ({ kind: x.kind, amount: money.rupees(x.amount) })),
      ...(bill ? { documentNo: bill.document.document_no, billTotal: bill.document.total, advanceUsed: money.rupees(bill.used.advance), depositUsed: money.rupees(bill.used.deposit),
        handedBack: money.rupees(refunded), ...(approval && refunded ? { approvedBy: approval.approver.name } : {}) } : {}) };
    await repo.audit(db, business.id, user.id, 'rental_booking.returned', booking.id, details);
    await repo.event(db, business.id, user.id, 'rental_booking.returned', 'rental_booking', booking.id, { ...details, returnId: ret.id, documentId: bill?.document.id || null,
      lines: plan.back.map((b) => ({ lineId: b.line.id, quantity: b.quantity, missing: b.missing })) });
    return bookings.shape(business, await bookings.load(db, business, booking.id));
  });
}

module.exports = { checkout, preview, takeBack, planReturn };
