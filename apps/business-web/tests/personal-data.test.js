import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedReason, boardWords, breachTone, consentAllows, consentChanges, dueWords, notAgreed, requestTone } from '../src/modules/personal-data/personalData.js';

// Personal data on the staff screens: the 90 days of a request, the Board's
// 72 hours on a breach, what a consent form sends, and why a message cannot go.

test("a request's 90 days: due in so many days, due today, or so many days late; the bell's tones", () => {
  assert.equal(dueWords(90), 'Due in 90 days');
  assert.equal(dueWords(1), 'Due in 1 day');
  assert.equal(dueWords(0), 'Due today');
  assert.equal(dueWords(-5), '5 days late');
  assert.equal(dueWords(-1), '1 day late');
  assert.equal(dueWords(null), '');
  assert.equal(requestTone({ status: 'open', days_left: 40 }), 'info');
  assert.equal(requestTone({ status: 'open', days_left: 15 }), 'warning');
  assert.equal(requestTone({ status: 'open', days_left: -1 }), 'danger');
  assert.equal(requestTone({ status: 'done', days_left: -9 }), 'success');
  assert.equal(requestTone({ status: 'refused', days_left: 3 }), 'neutral');
});

test("a breach shows the Board's report due, late, or sent", () => {
  const now = Date.parse('2026-10-27T10:00:00Z');
  const found = (hoursAgo) => ({ status: 'open', board_report_at: null, board_due_at: new Date(now + (72 - hoursAgo) * 3600000).toISOString() });
  assert.equal(boardWords(found(70), now), "Board's report due in 2 hours");
  assert.equal(boardWords(found(71), now), "Board's report due in 1 hour");
  assert.equal(boardWords(found(80), now), "Board's report 8 hours late");
  assert.equal(breachTone(found(70), now), 'warning');
  assert.equal(breachTone(found(80), now), 'danger');
  const reported = { ...found(80), board_report_at: '2026-10-27T09:00:00Z' };
  assert.equal(boardWords(reported, now), 'Report sent to the Board');
  assert.equal(breachTone(reported, now), 'info');
  assert.equal(breachTone({ ...reported, status: 'closed' }, now), 'neutral');
});

test('a consent form sends only what changed: a yes to record, a no to withdraw', () => {
  assert.equal(consentChanges({}, []), null);
  assert.equal(consentChanges(undefined, ['offers']), null);
  assert.deepEqual(consentChanges({ bills_digital: true, offers: false }, []), { bills_digital: true });
  assert.deepEqual(consentChanges({ bills_digital: false, reminders: true }, ['bills_digital']), { bills_digital: false, reminders: true });
  assert.equal(consentChanges({ reminders: true }, ['reminders']), null, 'a yes already recorded is not sent again');
});

test('a message goes only with consent to its purpose, never to an erased person, and offers never to a child', () => {
  const status = { purposes: ['reminders', 'offers'], child: false, erased: false };
  assert.equal(consentAllows(status, 'reminders'), true);
  assert.equal(consentAllows(status, 'bills_digital'), false);
  assert.equal(consentAllows({ ...status, child: true }, 'offers'), false);
  assert.equal(consentAllows({ ...status, child: true }, 'reminders'), true);
  assert.equal(consentAllows({ ...status, erased: true }, 'reminders'), false);
  assert.equal(consentAllows(undefined, 'reminders'), false);
  assert.equal(blockedReason(status, 'reminders', 'Sunita'), null);
  assert.equal(blockedReason(status, 'bills_digital', 'Sunita'), 'Sunita has not agreed to bills on WhatsApp or SMS.');
  assert.equal(blockedReason({ ...status, child: true }, 'offers', 'Arjun'), 'Arjun is marked as a child: offers are never sent to a child.');
  assert.equal(blockedReason({ ...status, erased: true }, 'reminders', 'Ravi'), "Ravi's data was erased at their request: nothing is sent to them.");
  assert.equal(notAgreed('Sunita', 'reminders').response.data.message, 'Sunita has not agreed to reminders on WhatsApp, SMS or a call: nothing was sent.');
});
