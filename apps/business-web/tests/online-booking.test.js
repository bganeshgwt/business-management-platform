import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASONS, STATUS, answerWithin, linkAddress, posterHtml, reminderText, rupees, shareText } from '../src/modules/business/online-booking/pages/onlineBooking.js';
import { words } from './helpers/defaultWords.js';

// Online booking's words on the staff screens: why a request waits, who is
// booked, how long the desk has, the link, the share text and the reminder,
// in each business's words.

const salon = words({ customer: ['Client', 'Clients'], provider: ['Stylist', 'Stylists'] });
const clinic = words({ customer: ['Patient', 'Patients'], provider: ['Doctor', 'Doctors'] });
const gym = words({ customer: ['Member', 'Members'], appointment: ['Session', 'Sessions'] });
const garage = words({ appointment: ['Service booking', 'Service bookings'] });

test('every reason a request waits and every status has its words', () => {
  assert.deepEqual(Object.keys(REASONS).sort(), ['advance', 'confirm', 'deposit', 'no_shows']);
  for (const status of ['requested', 'booked', 'completed', 'no_show', 'declined', 'expired', 'cancelled']) assert.ok(STATUS[status].label, status);
  assert.equal(STATUS.expired.label, 'Not answered in time');
});

test("a reason's explanation names the business's people", () => {
  assert.match(REASONS.deposit.hint(salon), /call the client and take it as you accept/);
  assert.match(REASONS.advance.hint(clinic), /^The patient paid the advance by UPI/);
  assert.equal(REASONS.confirm.hint(salon), 'The link asks the desk to accept every booking.');
  for (const reason of Object.values(REASONS)) assert.doesNotMatch(reason.hint(gym), /guest/i);
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
  assert.equal(shareText('Shine Salon', salon, 'https://x.in/a'), 'Book an appointment at Shine Salon online, any time: https://x.in/a');
  assert.equal(shareText('Fit Zone', gym, 'u'), 'Book a session at Fit Zone online, any time: u');
  assert.equal(shareText('Speed Auto', garage, 'u'), 'Make a service booking at Speed Auto online, any time: u');
  const text = reminderText({ booker_name: 'Asha Rao', services: 'Haircut + Beard trim', resource_name: 'Arjun', starts_at: '2026-11-08T04:30:00Z' }, 'Shine Salon', 'Asia/Kolkata');
  assert.match(text, /^Hi Asha, a reminder of your Haircut \+ Beard trim with Arjun at Shine Salon tomorrow, Sunday, 8 Nov at 10:00 am\./);
  assert.equal(rupees(1200.5), '₹1,200.5');
});

test('the poster names the business safely and carries what to book, the code and the address', () => {
  const html = posterHtml({ name: 'Shine <Salon>', logoUrl: '', qr: 'data:image/png;base64,AAA', url: 'https://x.in/a', place: '', t: gym, escape: (s) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;') });
  assert.match(html, /Shine &lt;Salon&gt;/);
  assert.match(html, /Book a session online/);
  assert.match(html, /src="data:image\/png;base64,AAA"/);
  assert.match(html, /https:\/\/x\.in\/a/);
  assert.doesNotMatch(html, /class="logo"/);
});
