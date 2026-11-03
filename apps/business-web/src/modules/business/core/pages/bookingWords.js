// How a business asks to book and says a booking is made, in its own words
// (services/terms.js): "Book a session", "Session booked", "Book an eye test".
// A word that is itself a booking ("Service booking", "Booking") is made, not
// booked: "Make a service booking", "Service booking made".
const isBooking = (t) => /\bbooking$/i.test(t("appointment"));

export const bookAction = (t) => `${isBooking(t) ? "Make" : "Book"} ${t.a("appointment")}`;
export const bookedNote = (t) => `${t("appointment")} ${isBooking(t) ? "made" : "booked"}`;
