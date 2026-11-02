import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASONS, STATUS, answerWithin, linkAddress, peopleWord, posterHtml, reminderText, rupees, shareText } from '../src/modules/business/online-booking/pages/onlineBooking.js';

// Online booking's words on the staff screens: why a request waits, who is
// booked, how long the desk has, the link, the share text and the reminder.

test('every reason a request waits and every status has its words', () => {
  assert.deepEqual(Object.keys(REASONS).sort(), ['advance', 'confirm', 'deposit', 'no_shows']);
  for (const status of ['requested', 'booked', 'completed', 'no_show', 'declined', 'expired', 'cancelled']) assert.ok(STATUS[status].label, status);
  assert.equal(STATUS.expired.label, 'Not answered in time');
});

test('the people a kind of business books', () => {
  assert.equal(peopleWord('salon'), 'stylist');
  assert.equal(peopleWord('healthcare', true), 'doctors');
  assert.equal(peopleWord('garage', true), 'bays and mechanics');
  assert.equal(peopleWord('grocery'), 'person');
});

test('how long the desk has to answer', () => {
  const now = Date.parse('2026-11-07T04:00:00Z');
  assert.equal(answerWithin('2026-11-07T04:12:00Z', now), 'in 12 min');
  assert.equal(answerWithin('2026-11-07T07:20:00Z', now), 'in 3 h 20 min');
  assert.equal(answerWithin('2026-11-07T06:00:00Z', now), 'in 2 h');
  assert.equal(answerWithin('2026-11-09T04:00:00Z', now), 'in 2 d');
  assert.equal(answerWithin('2026-11-07T03:00:00Z', now), 'now');
});

test('the link, the text to share it with, and the reminder', () => {
  assert.equal(linkAddress({ url: 'https://book.example.in/appointments/abc', token: 'abc' }), 'https://book.example.in/appointments/abc');
  assert.equal(linkAddress(null), '');
  assert.equal(shareText('Shine Salon', 'salon', 'https://x.in/a'), 'Book your salon appointment at Shine Salon online, any time: https://x.in/a');
  assert.match(shareText('Clear Vision', 'optical', 'u'), /your eye test at Clear Vision/);
  const text = reminderText({ booker_name: 'Asha Rao', services: 'Haircut + Beard trim', resource_name: 'Arjun', starts_at: '2026-11-08T04:30:00Z' }, 'Shine Salon', 'Asia/Kolkata');
  assert.match(text, /^Hi Asha, a reminder of your Haircut \+ Beard trim with Arjun at Shine Salon tomorrow, Sunday, 8 Nov at 10:00 am\./);
  assert.equal(rupees(1200.5), '₹1,200.5');
});

test('the poster names the business safely and carries the code and the address', () => {
  const html = posterHtml({ name: 'Shine <Salon>', logoUrl: '', qr: 'data:image/png;base64,AAA', url: 'https://x.in/a', place: '', type: 'healthcare', escape: (s) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;') });
  assert.match(html, /Shine &lt;Salon&gt;/);
  assert.match(html, /Book your doctor's appointment online/);
  assert.match(html, /src="data:image\/png;base64,AAA"/);
  assert.match(html, /https:\/\/x\.in\/a/);
  assert.doesNotMatch(html, /class="logo"/);
});
