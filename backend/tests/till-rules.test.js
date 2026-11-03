const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const rules = require('../src/modules/business/till/services/tillRules');

// The offline till's rules on the server (modules/business/till/services/
// tillRules.js): its numbers, the financial year and business date of a
// moment, the allowed window of a bill's time, the GST rate in force on a
// day. The till keeps the same rules (apps/business-web/src/modules/business/
// till/tillRules.js): both answer these cases alike.
const app = () => import(pathToFileURL(path.resolve(__dirname, '../../apps/business-web/src/modules/business/till/services/tillRules.js')).href);

test('the server and the till number bills and date them alike', async () => {
  const till = await app();
  for (const year of [2025, 2026, 2099]) assert.equal(rules.fiscalLabel(year), till.fiscalLabel(year));
  for (const [day, start] of [['2027-03-31', 4], ['2027-04-01', 4], ['2027-01-05', 1], ['2026-12-31', 1], ['2026-06-30', 7]]) {
    assert.equal(rules.fiscalYearOf(day, start), till.fiscalYearOf(day, start), `${day} from month ${start}`);
  }
  for (const [code, year, seq] of [['T1', 2026, 1], ['T12', 2026, 98765], ['T999', 2030, 7]]) {
    assert.equal(rules.billNumber(code, year, seq), till.billNumber(code, year, seq));
    assert.deepEqual(rules.readBillNumber(rules.billNumber(code, year, seq)), { code, label: rules.fiscalLabel(year), seq });
  }
  for (const instant of ['2027-03-31T18:20:00.000Z', '2027-03-31T18:40:00.000Z', '2026-11-01T18:29:59.000Z']) {
    assert.equal(rules.dayOf(instant, 'Asia/Kolkata'), till.dayOf(instant, 'Asia/Kolkata'));
  }
  assert.equal(rules.readBillNumber('SI/2627/0001'), null, 'a location\'s own series is not a till\'s');
  assert.equal(rules.readBillNumber('T0/2627/00001'), null);
  // Rates with changes still to come: both alike; one already made is known to the server only.
  const changes = [{ startsOn: '2027-04-01', rate: '5.00' }, { startsOn: '2027-10-01', rate: '12.00' }];
  for (const day of ['2027-03-31', '2027-04-01', '2027-12-25']) assert.equal(rules.rateOn('18.00', changes, day), till.rateOn('18.00', changes, day), day);
  assert.equal(rules.rateOn('5.00', [{ startsOn: '2027-04-01', rate: '5.00', fromRate: '18.00' }], '2027-03-31'), 18, 'the day before an applied change: the rate it moved from');
  assert.equal(rules.rateOn('5.00', [{ startsOn: '2027-04-01', rate: '5.00', fromRate: '18.00' }], '2027-04-01'), 5);
});

test('a bill\'s time outside the allowed window: ahead of its arrival, before the till, or past the offline limit', () => {
  const received = '2026-11-02T12:00:00.000Z';
  const at = (minutes) => new Date(Date.parse(received) + minutes * 60000).toISOString();
  assert.equal(rules.timeProblem({ madeAt: at(-30), receivedAt: received, registeredAt: at(-600) }), null);
  assert.equal(rules.timeProblem({ madeAt: at(4), receivedAt: received, registeredAt: at(-600) }), null, 'a clock a few minutes ahead is grace');
  assert.equal(rules.timeProblem({ madeAt: at(30), receivedAt: received, registeredAt: at(-600) }).why, 'future');
  assert.equal(rules.timeProblem({ madeAt: at(-700), receivedAt: received, registeredAt: at(-600) }).why, 'before');
  assert.equal(rules.timeProblem({ madeAt: at(-60), receivedAt: received, registeredAt: at(-6000), offlineSince: at(-60 * 70), stopHours: 72 }), null, 'made within the 72 hours');
  assert.equal(rules.timeProblem({ madeAt: at(-60), receivedAt: received, registeredAt: at(-9000), offlineSince: at(-60 * 74), stopHours: 72 }).why, 'limit');
});
