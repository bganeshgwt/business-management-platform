const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const takings = require('../../core/services/businessTakings.service');
const c = require('./lodgingCommon');
const money = require('./lodgingMoney');
const stays = require('./lodgingStays.service');
const folio = require('./lodgingFolio.service');

// The night audit (module "lodging"), for one property or every property, on
// the business's own date:
//
//   room nights  every stay in the house gets its room nights up to tonight
//                (or the night before it leaves) not posted yet, each at its
//                night's rates and the GST slab its value decides, with its
//                plan's meals (lodgingFolio postNightsIn).
//   no-shows     a reservation not checked in by the property's no-show cut-off
//                on its arrival day (or one whose arrival day has passed) is
//                marked a no-show, its charge worked out by the policy it was
//                booked under (none under no policy) and billed, what is held
//                for it paying first. Only someone who may cancel (and bill,
//                when there is a charge) marks them; for anyone else they are
//                listed. With no cut-off set, no-shows are marked by hand.
//   the day      closed with the shared day close (Reports' takings for the
//                day): its money as it then stood is kept with the audit.
// Each run is kept (lodging_night_audits). The business date is the date on
// the business's own clock: the audit closes it, and a front-desk date that
// lags the calendar is not kept (it would break "Dates on the business's
// clock": bills and nights are dated by that clock). Run again, it posts and
// marks nothing twice.

const { fail, id } = c;

// The reservations past the property's no-show cut-off on their arrival day, not checked in.
const DUE_SQL = `SELECT s.id,s.stay_no,s.guest_name,s.arrival::text AS arrival,s.location_id FROM lodging_stays s JOIN businesses z ON z.id=s.business_id
  WHERE s.business_id=$1 AND s.status='reserved' AND ($2::bigint IS NULL OR s.location_id=$2) AND now()>((s.arrival+$3::time) AT TIME ZONE z.timezone)
  ORDER BY s.arrival,s.id`;

// The day close's figures kept with the audit: the bills, the money in by kind, the money out, the cash.
const dayCloseOf = (t) => ({ bills: t.sales.bills, sales: t.sales.total, returns: t.sales.returns, received: { cash: t.received.cash, upi: t.received.upi, card: t.received.card,
  bank: t.received.bank, cheque: t.received.cheque, total: t.received.total }, refunds: t.refunds.total, suppliers: t.suppliers.total, cashInHand: t.cashInHand, net: t.net });

// body: { locationId? (one property; the person's, or every property, when left out) }
async function run(business, user, body = {}) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const locationId = c.given(body.locationId) ? id(body.locationId, 'Property') : null;
  if (locationId) access.requireLocation(business, locationId);
  const scope = locationId || business.location_scope || null;
  const mayMark = access.can(business, 'lodging.cancel');
  const mayBill = access.can(business, 'sales.create');
  const seesDay = access.can(business, 'reports.view') || access.can(business, 'sales.view');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    if (scope && !await repo.one(db, 'SELECT 1 FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, scope])) fail('Property not found', 404);
    const today = await c.today(db, business);
    const nights = await folio.postNightsIn(db, business, user, { today, locationId: scope });
    // The no-shows past the property's cut-off.
    const settings = await c.settingsOf(db, business.id);
    const cutoff = settings.no_show_cutoff ? c.hhmm(settings.no_show_cutoff) : null;
    const due = cutoff ? await repo.all(db, DUE_SQL, [business.id, scope, cutoff]) : [];
    const marked = [], left = [];
    for (const row of due) {
      const stay = await repo.one(db, 'SELECT * FROM lodging_stays WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, row.id]);
      if (stay.status !== 'reserved') continue;
      const terms = stay.policy ? await stays.policyNow(db, business, stay) : null;
      const charge = terms ? terms.noShow.amount : 0;
      if (!mayMark || (charge > 0 && !mayBill)) {
        left.push({ stayId: stay.id, stayNo: stay.stay_no, guestName: stay.guest_name, arrival: row.arrival });
        continue;
      }
      const reason = `Not checked in by ${cutoff} on ${c.dateWords(row.arrival)}: marked by the night audit of ${c.dateWords(today)}`;
      const done = await stays.cancelIn(db, business, user, stay, { requestKey: c.derivedKey(`night-audit:${business.id}:${stay.id}`, 'no-show'),
        hash: c.hashOf({ noShow: true, audit: today, stayId: String(stay.id) }), reason, noShow: true });
      marked.push({ stayId: stay.id, stayNo: stay.stay_no, guestName: stay.guest_name, arrival: row.arrival, charge: money.rupees(done.charge),
        documentNo: done.bill?.document.document_no || null, total: done.bill?.document.total || null });
    }
    // The day's money, as the shared day close has it now.
    const dayClose = seesDay ? dayCloseOf(await takings.takings(business, { from: today, to: today, locationId: scope }, db)) : null;
    const record = await repo.one(db, `INSERT INTO lodging_night_audits(business_id,location_id,day,nights,no_shows,day_close,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at`,
      [business.id, scope, today, nights.nights, marked.length, dayClose ? JSON.stringify(dayClose) : null, user.id]);
    await repo.audit(db, business.id, user.id, 'lodging.night_audit', null, { today, locationId: scope, stays: nights.posted.length, nights: nights.nights, noShows: marked.map((m) => m.stayNo),
      noShowsLeft: left.map((m) => m.stayNo) });
    const money2 = c.seesMoney(business);
    return {
      id: record.id, today, locationId: scope, nights: nights.nights, stays: nights.stays, noShowCutoff: cutoff,
      posted: money2 ? nights.posted : nights.posted.map((p) => ({ ...p, nights: p.nights.map((n) => ({ night: n.night, rateKind: n.rateKind })) })),
      noShows: money2 ? marked : marked.map((m) => ({ ...m, charge: null, total: null })), noShowsLeft: left, dayClose,
    };
  });
}

module.exports = { run };
