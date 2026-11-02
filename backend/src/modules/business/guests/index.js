// The shared pieces of a business's guest pages (ARCHITECTURE.md › Building a
// guest page for a business), one file per concern under services/:
//
//   guestContacts.js     findOrCreateGuestContact, and reading a guest's name, mobile and email
//   guestConsents.js     readGuestChoices, recordGuestConsents
//   guestBusinessCard.js guestBusinessCard: the band and the seller details a page shows
//   guestOrders.js       assertBusinessTakingOrders: the plan and the business's status, on every write
//   guestLimiter.js      guestLimiter: rate limits per client address, link or mobile
//   guestHours.js        openState: open now, or when it opens next (pure)
//   privacyRef.js        the reference of a business's privacy notice link
//   guestNotice.js       the notice a guest reads by that reference
//
// A guest page's live updates are the live module's: guestKeys.issue gives
// the key its status answer carries (modules/live/services/guestKeys.js).
// A guest's own action is audited with repo.guestAudit (no actor, channel
// guests_site).

module.exports = {
  ...require("./services/guestContacts"),
  ...require("./services/guestConsents"),
  ...require("./services/guestBusinessCard"),
  ...require("./services/guestOrders"),
  ...require("./services/guestLimiter"),
  ...require("./services/guestHours"),
  privacyRef: require("./services/privacyRef"),
  ...require("./services/guestNotice"),
};
