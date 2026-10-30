// What of a lab order is billed, and how the rest would be billed. Pure: no
// database, so the rules are tested on their own (tests/clinic-lab-rules.test.js).
//
// A test ordered on its own is billed as its service, at its price; the
// tests a profile brought are billed as the profile's service, one line for
// them all, while none of them is billed yet (once one is, or when the
// profile has no service, each of the rest is billed as its own). A cancelled
// test is never billed, and a billed one never again. A test with no
// service (Billed as, on Tests & panels) cannot be billed from its order.
//
// rows: an order's tests, in order: { id, test_id, code, name, sku_id, price,
//   profile_id, profile_code, profile_name, profile_sku_id, profile_price,
//   document_line_id, cancelled }

const live = (row) => !row.cancelled;
const billed = (row) => row.document_line_id !== null && row.document_line_id !== undefined;
const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
// Rows of several orders: a profile's tests are those of one order.
const sameOrder = (a, b) => String(a.order_id ?? '') === String(b.order_id ?? '');

// The order's billing as one word: none (nothing billed), billed (no test
// left to bill) or part.
function billingState(rows) {
  const list = rows || [];
  if (!list.some(billed)) return 'none';
  return list.some((row) => live(row) && !billed(row)) ? 'part' : 'billed';
}

// The units the order's unbilled tests would be billed as, in the order's
// order: [{ key, kind (test or profile), test_id (of the test or profile),
// code, label, sku_id, price, order_test_ids }], and the unbilled tests that
// have no service to bill (noService: their ids).
function billingUnits(rows) {
  const list = rows || [];
  const units = [];
  const noService = [];
  const seen = new Set();
  for (const row of list) {
    if (!live(row) || billed(row) || seen.has(String(row.id))) continue;
    const members = row.profile_id === null || row.profile_id === undefined ? [] : list.filter((other) => sameOrder(other, row) && same(other.profile_id, row.profile_id));
    const order = row.order_id ?? null;
    // A profile is billed as one while none of its tests is billed yet.
    if (members.length && row.profile_sku_id && !members.some(billed)) {
      const ids = members.filter(live).map((member) => member.id);
      for (const id of ids) seen.add(String(id));
      units.push({ key: `profile:${order ?? ''}:${row.profile_id}`, kind: 'profile', order_id: order, test_id: row.profile_id, code: row.profile_code, label: row.profile_name,
        sku_id: row.profile_sku_id, price: row.profile_price ?? null, order_test_ids: ids });
      continue;
    }
    seen.add(String(row.id));
    if (!row.sku_id) { noService.push(row.id); continue; }
    units.push({ key: `test:${row.id}`, kind: 'test', order_id: order, test_id: row.test_id, code: row.code, label: row.name, sku_id: row.sku_id, price: row.price ?? null,
      order_test_ids: [row.id] });
  }
  return { units, noService };
}

// The units holding any of the tests asked for (a profile's test brings the
// profile), and why any test asked for cannot be billed now:
// { units, refused: [{ id, why: missing | cancelled | billed | no_service }] }.
function unitsFor(rows, wanted) {
  const list = rows || [];
  const { units, noService } = billingUnits(list);
  const ids = [...new Set((wanted || []).map(String))];
  const refused = [];
  for (const id of ids) {
    const row = list.find((r) => String(r.id) === id);
    if (!row) refused.push({ id, why: 'missing' });
    else if (!live(row)) refused.push({ id, why: 'cancelled', row });
    else if (billed(row)) refused.push({ id, why: 'billed', row });
    else if (noService.some((n) => String(n) === id)) refused.push({ id, why: 'no_service', row });
  }
  return { units: units.filter((unit) => unit.order_test_ids.some((id) => ids.includes(String(id)))), refused };
}

module.exports = { billingState, billingUnits, unitsFor };
