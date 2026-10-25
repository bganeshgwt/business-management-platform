const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const c = require('./rentalsCommon');

// The deposits held (module "rentals"): the refundable deposits taken for
// bookings, kept apart from sales. Each is a core collection receipt in the
// hirer's name; what of it paid the booking's bill (applied: part of the
// payment then, the bill carrying its GST) and what was handed back are the
// core's own payments and refunds of that receipt. What is left is held: the
// shop owes it to the hirer until it pays a bill or goes back.
//
//   the ledger  one row a booking: its deposit asked, collected, applied to
//               its bill, handed back and held now, with its receipts.
//   the total   what is held for every booking (the deposits the shop owes).

const LEDGER_SQL = `SELECT x.*,(x.collected-x.applied-x.refunded) AS held,(x.collected-x.applied-x.refunded>0) AS holding,
    CASE WHEN x.collected-x.applied-x.refunded<=0 THEN 'settled' WHEN x.status IN ('returned','cancelled') THEN 'to_hand_back' ELSE 'held' END AS state
  FROM (
  SELECT b.id,b.booking_no,b.location_id,l.name AS location_name,b.contact_id,b.customer_name,b.customer_phone,b.status,b.out_at,b.due_at,b.returned_at,b.cancelled_at,
    b.deposit_due,b.document_id,d.document_no,min(k.created_at) AS first_taken_at,
    string_agg(k.collection_no,', ' ORDER BY k.id) AS receipts,
    sum(k.amount) AS collected,
    sum(COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=k.business_id AND p.collection_id=k.id),0)) AS applied,
    sum(COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=k.business_id AND f.collection_id=k.id),0)) AS refunded,
    max(COALESCE((SELECT max(f.created_at) FROM business_collection_refunds f WHERE f.business_id=k.business_id AND f.collection_id=k.id),k.created_at)) AS last_at
  FROM rental_receipts r JOIN business_collections k ON k.business_id=r.business_id AND k.id=r.collection_id
  JOIN rental_bookings b ON b.business_id=r.business_id AND b.id=r.booking_id JOIN business_locations l ON l.business_id=b.business_id AND l.id=b.location_id
  LEFT JOIN business_documents d ON d.business_id=b.business_id AND d.id=b.document_id
  WHERE r.business_id=$1 AND r.purpose='deposit'
  GROUP BY b.id,l.name,d.document_no) x`;

repo.addLists({
  // Every booking that took a deposit: those still holding money first (to hand back before those still out), then by when it was taken.
  'rental-deposits': { sql: LEDGER_SQL, search: ['booking_no', 'customer_name', 'customer_phone', 'receipts', 'document_no'], date: 'first_taken_at',
    filters: { state: 'state', holding: 'holding', location: 'location_id', contact: 'contact_id', status: 'status' },
    order: "holding DESC,state='to_hand_back' DESC,first_taken_at DESC,id DESC" },
});

// What every booking holds, and what was collected, applied and handed back, in all (or at one location).
async function totals(business) {
  c.requireRentals(business);
  await access.require(business, 'rentals.view');
  if (!c.seesMoney(business)) return null;
  return repo.one(repo.pool, `SELECT COALESCE(sum(held) FILTER (WHERE held>0),0) AS held,count(*) FILTER (WHERE held>0)::int AS bookings,
      count(*) FILTER (WHERE state='to_hand_back')::int AS to_hand_back,COALESCE(sum(held) FILTER (WHERE state='to_hand_back'),0) AS to_hand_back_amount,
      COALESCE(sum(collected),0) AS collected,COALESCE(sum(applied),0) AS applied,COALESCE(sum(refunded),0) AS refunded
    FROM (${LEDGER_SQL}) z WHERE ($2::bigint IS NULL OR z.location_id=$2)`, [business.id, business.location_scope || null]);
}

module.exports = { LEDGER_SQL, totals };
