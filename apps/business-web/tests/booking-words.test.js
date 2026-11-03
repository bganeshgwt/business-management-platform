import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookAction, bookedNote } from '../src/modules/business/core/pages/bookingWords.js';
import { defaultT, words } from './helpers/defaultWords.js';

// How each business asks to book and says it is booked, in its own word for
// a booking (core/pages/bookingWords.js): the Overview's action, the bookings
// list's button and dialog, its notice and the activity log.

test('a booking is booked, in the business\'s word, with "a" or "an"', () => {
  assert.equal(bookAction(defaultT), 'Book an appointment');
  assert.equal(bookedNote(defaultT), 'Appointment booked');
  const gym = words({ appointment: ['Session', 'Sessions'] });
  assert.equal(bookAction(gym), 'Book a session');
  assert.equal(bookedNote(gym), 'Session booked');
  assert.equal(bookAction(words({ appointment: ['Eye test', 'Eye tests'] })), 'Book an eye test');
});

test('a word that is itself a booking is made, never "booked a booking"', () => {
  const garage = words({ appointment: ['Service booking', 'Service bookings'] });
  assert.equal(bookAction(garage), 'Make a service booking');
  assert.equal(bookedNote(garage), 'Service booking made');
  // An owner who calls them just "Booking".
  assert.equal(bookAction(words({ appointment: ['Booking', 'Bookings'] })), 'Make a booking');
});
