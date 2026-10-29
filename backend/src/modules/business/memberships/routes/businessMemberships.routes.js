const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const access = require('../../core/services/businessAccess.service');
const { requireMemberships } = require('../services/memberCommon');
const plans = require('../services/memberPlans.service');
const memberships = require('../services/memberships.service');
const changes = require('../services/memberChanges.service');
const checkins = require('../services/memberCheckins.service');
const renewals = require('../services/memberRenewals.service');
const account = require('../services/memberAccount.service');
const classes = require('../services/memberClasses.service');
const pay = require('../services/memberPay.service');
const people = require('../services/memberPeople.service');

// Gyms, studios and coaching centres, added to the Business Admin router so
// they share its login, membership, module and permission checks (context)
// and its database-error translation:
//   /:businessId/member-plans/plans…          plans with their item, freeze, grace and transfer rules and refund policy versions
//   /:businessId/member-plans/settings        when overdue fees turn a member away at check-in
//   /:businessId/member-plans/members…        members with their current membership; a member's page; their code
//   /:businessId/member-plans/memberships…    sell and renew (with a preview), freeze, unfreeze, transfer, upgrade
//                                            and cancel (each money change with a preview), reminders
//   /:businessId/member-plans/check-ins       check a member in; the day's check-ins
//   /:businessId/member-plans/renewals        memberships ending soon or ended lately, not yet renewed
//   /:businessId/member-plans/instalments     fees in instalments, due and overdue
//   /:businessId/member-plans/counts|approvers  the day's picture; who may approve what a cancellation gives back
//   /:businessId/member-plans/memberships/brought-in  a running membership from another system (no bill)
//   /:businessId/member-plans/memberships/:id/seats|addons|instalments|late-fee  a shared membership's seats, add-ons, the schedule, a late fee
//   /:businessId/member-plans/refunds…        refunds due, and paying one
//   /:businessId/member-plans/rooms|class-slots|classes…  rooms, the weekly timetable, the classes and their bookings and attendance
//   /:businessId/member-plans/pay…            trainers' pay and sales commission: rules, the month, payouts
//   /:businessId/member-plans/members/:contactId/profile|guardians|results, /guardians/:id, /results/:id  a student's details
//   /:businessId/member-plans/leads…          enquiries, the follow-up list, trial passes
//   /:businessId/member-plans/birthdays|sessions-low|grace-end  the reminder lists
// The member's signed acceptance of the refund policy is a file: memberUploads.routes.js.
// Another type of business never has the module, so `context` refuses it;
// the services repeat every check and answer 404 for another type.

module.exports = function membershipsRoutes(router, { context, send, b }) {
  // check: refuses before the query; shape: what the caller's role sees of the page.
  const list = (path, name, permission, check, shape) => router.get(b(path), context(permission), async (req, res) => {
    requireMemberships(req.business);
    if (check) await check(req.business);
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    for (const key of repo.listFilters(name)) if (req.query[key] !== undefined && req.query[key] !== '') filters[key] = String(req.query[key]).slice(0, 60);
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    const date = (value, label) => (value === undefined || value === '' ? null : core.dateText(value, label));
    const from = date(req.query.from, 'From date'), to = date(req.query.to, 'To date');
    if (from && to && to < from) throw new AppError(400, 'The end date is before the start date');
    const page = await repo.page(req.business.id, name, limit, offset, { search, from, to, timezone: req.business.timezone, filters });
    send(res, shape ? shape(req.business, page) : page);
  });
  // Fees are money: their list is for those who see sales.
  const seesSales = (business) => access.require(business, 'sales.view');

  // Plans and the check-in rule.
  list('/member-plans/plans', 'member-plans', 'member_plans.view');
  router.post(b('/member-plans/plans'), context('member_plans.edit'), async (req, res) => send(res, await plans.create(req.business, req.user, req.body), 201));
  router.get(b('/member-plans/plans/:id'), context('member_plans.view'), async (req, res) => send(res, await plans.detail(req.business, req.params.id)));
  router.put(b('/member-plans/plans/:id'), context('member_plans.edit'), async (req, res) => send(res, await plans.update(req.business, req.user, req.params.id, req.body)));
  router.get(b('/member-plans/settings'), context('member_plans.view'), async (req, res) => send(res, await plans.settings(req.business)));
  router.put(b('/member-plans/settings'), context('settings.edit'), async (req, res) => send(res, await plans.saveSettings(req.business, req.user, req.body)));
  router.get(b('/member-plans/approvers'), context(['member_plans.cancel', 'member_plans.approve']), async (req, res) => send(res, await plans.approvers(req.business)));
  router.get(b('/member-plans/counts'), context('member_plans.view'), async (req, res) => send(res, await renewals.counts(req.business)));

  // Members.
  list('/member-plans/members', 'member-members', 'member_plans.view', null, memberships.listShape);
  router.get(b('/member-plans/members/:contactId'), context('member_plans.view'), async (req, res) => send(res, await memberships.member(req.business, req.params.contactId)));
  router.put(b('/member-plans/members/:contactId/code'), context('member_plans.edit'), async (req, res) =>
    send(res, await memberships.changeCode(req.business, req.user, req.params.contactId, req.body)));

  // Memberships: selling and renewing, and every change to one.
  list('/member-plans/memberships', 'member-memberships', 'member_plans.view', null, memberships.listShape);
  router.post(b('/member-plans/memberships/preview'), context('member_plans.create'), async (req, res) => send(res, await memberships.preview(req.business, req.user, req.body)));
  router.post(b('/member-plans/memberships'), context('member_plans.create'), async (req, res) => send(res, await memberships.sell(req.business, req.user, req.body), 201));
  router.get(b('/member-plans/memberships/:id'), context('member_plans.view'), async (req, res) => send(res, await memberships.detail(req.business, req.params.id)));
  router.post(b('/member-plans/memberships/:id/freeze'), context('member_plans.edit'), async (req, res) => send(res, await changes.freeze(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/member-plans/memberships/:id/unfreeze'), context('member_plans.edit'), async (req, res) => send(res, await changes.unfreeze(req.business, req.user, req.params.id, req.body)));
  router.post(b('/member-plans/memberships/:id/transfer'), context('member_plans.edit'), async (req, res) => send(res, await changes.transfer(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/member-plans/memberships/:id/upgrade/preview'), context('member_plans.edit'), async (req, res) =>
    send(res, await changes.upgradePreview(req.business, req.user, req.params.id, req.body)));
  router.post(b('/member-plans/memberships/:id/upgrade'), context('member_plans.edit'), async (req, res) => send(res, await changes.upgrade(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/member-plans/memberships/:id/cancel/preview'), context('member_plans.cancel'), async (req, res) =>
    send(res, await changes.cancelPreview(req.business, req.user, req.params.id, req.body)));
  router.post(b('/member-plans/memberships/:id/cancel'), context('member_plans.cancel'), async (req, res) => send(res, await changes.cancel(req.business, req.user, req.params.id, req.body)));
  router.post(b('/member-plans/memberships/:id/reminders'), context('member_plans.view'), async (req, res) => send(res, await renewals.remind(req.business, req.user, req.params.id, req.body), 201));

  // The front desk.
  router.post(b('/member-plans/check-ins'), context('member_plans.create'), async (req, res) => send(res, await checkins.checkIn(req.business, req.user, req.body), 201));
  list('/member-plans/check-ins', 'member-checkins', 'member_plans.view');

  // Renewal calls and fees due.
  list('/member-plans/renewals', 'member-renewals', 'member_plans.view', null, memberships.listShape);
  list('/member-plans/instalments', 'member-instalments', 'member_plans.view', seesSales);
  // The reminder lists: birthdays, packs running low, grace days ending.
  list('/member-plans/birthdays', 'member-birthdays', 'member_plans.view');
  list('/member-plans/sessions-low', 'member-sessions-low', 'member_plans.view', null, memberships.listShape);
  list('/member-plans/grace-end', 'member-grace-end', 'member_plans.view', null, memberships.listShape);

  // Brought in from another system; and a membership's seats, add-ons, schedule and late fee.
  router.post(b('/member-plans/memberships/brought-in'), context('member_plans.edit'), async (req, res) => send(res, await memberships.bringIn(req.business, req.user, req.body), 201));
  router.post(b('/member-plans/memberships/:id/seats'), context('member_plans.edit'), async (req, res) => send(res, await account.addSeat(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/member-plans/memberships/:id/seats/:seatId/remove'), context('member_plans.edit'), async (req, res) =>
    send(res, await account.removeSeat(req.business, req.user, req.params.id, req.params.seatId)));
  router.post(b('/member-plans/memberships/:id/addons'), context('member_plans.create'), async (req, res) => send(res, await account.addAddon(req.business, req.user, req.params.id, req.body), 201));
  router.put(b('/member-plans/memberships/:id/instalments'), context('member_plans.approve'), async (req, res) =>
    send(res, await account.changeInstalments(req.business, req.user, req.params.id, req.body)));
  router.post(b('/member-plans/memberships/:id/late-fee'), context('member_plans.edit'), async (req, res) => send(res, await account.lateFee(req.business, req.user, req.params.id, req.body), 201));

  // Refunds due.
  list('/member-plans/refunds', 'member-refunds', 'member_plans.view', seesSales);
  router.post(b('/member-plans/refunds/:id/pay'), context('member_plans.refund'), async (req, res) => send(res, await account.payRefund(req.business, req.user, req.params.id, req.body)));

  // Classes: rooms, the weekly timetable, the classes of the days, bookings and attendance.
  router.get(b('/member-plans/rooms'), context('member_plans.view'), async (req, res) => send(res, await classes.rooms(req.business)));
  router.post(b('/member-plans/rooms'), context('member_plans.edit'), async (req, res) => send(res, await classes.saveRoom(req.business, req.user, null, req.body), 201));
  router.put(b('/member-plans/rooms/:id'), context('member_plans.edit'), async (req, res) => send(res, await classes.saveRoom(req.business, req.user, req.params.id, req.body)));
  router.get(b('/member-plans/class-slots'), context('member_plans.view'), async (req, res) => send(res, await classes.slots(req.business)));
  router.post(b('/member-plans/class-slots'), context('member_plans.edit'), async (req, res) => send(res, await classes.saveSlot(req.business, req.user, null, req.body), 201));
  router.put(b('/member-plans/class-slots/:id'), context('member_plans.edit'), async (req, res) => send(res, await classes.saveSlot(req.business, req.user, req.params.id, req.body)));
  router.get(b('/member-plans/classes'), context('member_plans.view'), async (req, res) => send(res, await classes.week(req.business, req.query)));
  router.get(b('/member-plans/classes/:id'), context('member_plans.view'), async (req, res) => send(res, await classes.session(req.business, req.params.id)));
  router.post(b('/member-plans/classes/:id/bookings'), context('member_plans.create'), async (req, res) => send(res, await classes.book(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/member-plans/classes/:id/call-off'), context('member_plans.edit'), async (req, res) => send(res, await classes.callOff(req.business, req.user, req.params.id, req.body)));
  router.post(b('/member-plans/class-bookings/:id/cancel'), context('member_plans.create'), async (req, res) => send(res, await classes.cancelBooking(req.business, req.user, req.params.id)));
  router.post(b('/member-plans/class-bookings/:id/attendance'), context('member_plans.create'), async (req, res) =>
    send(res, await classes.mark(req.business, req.user, req.params.id, req.body)));

  // Trainers' pay and sales commission.
  router.get(b('/member-plans/pay'), context('member_plans.manage'), async (req, res) => send(res, await pay.report(req.business, req.query)));
  router.get(b('/member-plans/pay/rules'), context('member_plans.manage'), async (req, res) => send(res, await pay.rules(req.business)));
  router.post(b('/member-plans/pay/rules'), context('member_plans.manage'), async (req, res) => send(res, await pay.addRule(req.business, req.user, req.body), 201));
  router.post(b('/member-plans/pay/payouts'), context('member_plans.manage'), async (req, res) => send(res, await pay.payout(req.business, req.user, req.body), 201));

  // A student's details, guardians and test results.
  router.put(b('/member-plans/members/:contactId/profile'), context('member_plans.edit'), async (req, res) =>
    send(res, await people.saveProfile(req.business, req.user, req.params.contactId, req.body)));
  router.post(b('/member-plans/members/:contactId/guardians'), context('member_plans.edit'), async (req, res) =>
    send(res, await people.addGuardian(req.business, req.user, req.params.contactId, req.body), 201));
  router.put(b('/member-plans/guardians/:id'), context('member_plans.edit'), async (req, res) => send(res, await people.updateGuardian(req.business, req.user, req.params.id, req.body)));
  router.post(b('/member-plans/members/:contactId/results'), context('member_plans.edit'), async (req, res) =>
    send(res, await people.addResult(req.business, req.user, req.params.contactId, req.body), 201));
  router.put(b('/member-plans/results/:id'), context('member_plans.edit'), async (req, res) => send(res, await people.updateResult(req.business, req.user, req.params.id, req.body)));

  // Enquiries and trial passes.
  list('/member-plans/leads', 'member-leads', 'member_plans.view');
  router.post(b('/member-plans/leads'), context('member_plans.create'), async (req, res) => send(res, await people.addLead(req.business, req.user, req.body), 201));
  router.put(b('/member-plans/leads/:id'), context('member_plans.create'), async (req, res) => send(res, await people.updateLead(req.business, req.user, req.params.id, req.body)));
  router.post(b('/member-plans/leads/:id/trial'), context('member_plans.create'), async (req, res) => send(res, await people.trial(req.business, req.user, req.params.id, req.body), 201));
};
