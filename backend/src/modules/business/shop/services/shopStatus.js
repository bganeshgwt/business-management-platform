// An online order's statuses, as the guest's status page and the staff's
// board both show them (pure): the same steps, the same words, the same
// clocks, so the two sides never tell a different story.
//
//   placed            sent; waiting for the shop to accept (declined by the
//                     shop's own rule at auto_decline_at)
//   accepted          the shop has it; packing may have started (packing_at)
//   packed            packed and billed: the final amount is known
//   ready             (pickup) waiting at the counter
//   out_for_delivery  (delivery) on its way, with the delivery person's name
//   completed         collected or delivered, and paid or on account
//   declined          by the shop with a reason, or by the shop's own rule
//   cancelled         by the guest (before packing), or by the shop with a
//                     reason (refused at the door: the bill taken back)

const OPEN = ['placed', 'accepted', 'packed', 'ready', 'out_for_delivery'];
const FINAL = ['completed', 'declined', 'cancelled'];

const STEPS = {
  pickup: [['placed', 'Placed'], ['accepted', 'Accepted'], ['packed', 'Packed'], ['ready', 'Ready for pickup'], ['completed', 'Collected']],
  delivery: [['placed', 'Placed'], ['accepted', 'Accepted'], ['packed', 'Packed'], ['out_for_delivery', 'Out for delivery'], ['completed', 'Delivered']],
};

// The staff board's lanes.
const LANES = {
  new: ['placed'],
  packing: ['accepted'],
  out: ['packed', 'ready', 'out_for_delivery'],
  done: ['completed', 'declined', 'cancelled'],
};
const laneOf = (status) => Object.keys(LANES).find((lane) => LANES[lane].includes(status)) || 'done';

// The guest may cancel until packing starts, and change an order (cancel it
// and take its items back to the cart) until the shop accepts it.
const canCancel = (order) => order.status === 'placed' || (order.status === 'accepted' && !order.packing_at);
const canChange = (order) => order.status === 'placed';

const PAYMENT_WORDS = { pay_at_shop: 'Pay at the shop when you collect', cash_on_delivery: 'Cash on delivery', upi_on_delivery: 'UPI on delivery' };
const SUBSTITUTION_WORDS = { remove: 'Remove it', similar: 'Replace with something similar', call: 'Call me' };
const LINE_WORDS = { pending: 'To pack', ok: 'Packed', short: 'Fewer than ordered', unavailable: 'Not available', replaced: 'Replaced' };

// What the order's page says now: { key, label, detail, stopped }. `clock`
// writes a time on the business's clock ("7:42 pm").
function stageOf(order, clock = (at) => String(at)) {
  const pickup = order.service === 'pickup';
  switch (order.status) {
    case 'placed':
      return { key: 'placed', label: 'Placed: waiting for the shop to accept', stopped: false,
        detail: `If the shop does not accept it by ${clock(order.auto_decline_at)}, it is declined by itself and you pay nothing.` };
    case 'accepted':
      return order.packing_at
        ? { key: 'accepted', label: 'Accepted: being packed', stopped: false, detail: 'The shop is packing your order. You will see the final amount once it is packed.' }
        : { key: 'accepted', label: 'Accepted', stopped: false, detail: 'The shop will pack your order soon. You can still cancel until packing starts.' };
    case 'packed':
      return { key: 'packed', label: 'Packed', stopped: false,
        detail: pickup ? 'Your order is packed and billed. The shop will tell you here when it is ready to collect.' : 'Your order is packed and billed, and will leave the shop soon.' };
    case 'ready':
      return { key: 'ready', label: 'Ready for pickup', stopped: false, detail: 'Collect it at the counter, and pay there. Show your order number.' };
    case 'out_for_delivery':
      return { key: 'out_for_delivery', label: 'Out for delivery', stopped: false,
        detail: order.rider_name ? `${order.rider_name} is bringing your order.` : 'Your order is on its way.' };
    case 'completed':
      return { key: 'completed', label: pickup ? 'Collected' : 'Delivered', stopped: false, detail: 'Thank you for ordering.' };
    case 'declined':
      return { key: 'declined', label: order.declined_auto ? 'The shop did not respond' : 'Declined by the shop', stopped: true,
        detail: order.declined_auto ? 'The shop did not accept your order in time, so it was declined. You pay nothing. Please call the shop if you still need it.'
          : order.decline_reason };
    case 'cancelled':
      return { key: 'cancelled', label: order.cancelled_by === 'guest' ? 'Cancelled by you' : 'Cancelled by the shop', stopped: true,
        detail: order.cancelled_by === 'guest' ? null : order.cancel_reason };
    default:
      return { key: order.status, label: order.status, stopped: false, detail: null };
  }
}

// The timeline: each step with the time it was reached (written on the business's clock).
function stepsOf(order, clock = (at) => String(at)) {
  const at = { placed: order.placed_at, accepted: order.accepted_at, packed: order.packed_at, ready: order.ready_at, out_for_delivery: order.out_at, completed: order.completed_at };
  return STEPS[order.service].map(([key, label]) => ({ key, label, at: at[key] ? clock(at[key]) : null }));
}

// The step reached, for the timeline (a declined or cancelled order stays where it stopped).
function currentStep(order) {
  if (['declined', 'cancelled'].includes(order.status)) {
    if (order.out_at) return 'out_for_delivery';
    if (order.ready_at) return 'ready';
    if (order.packed_at) return 'packed';
    if (order.accepted_at) return 'accepted';
    return 'placed';
  }
  return order.status;
}

module.exports = { OPEN, FINAL, STEPS, LANES, laneOf, canCancel, canChange, PAYMENT_WORDS, SUBSTITUTION_WORDS, LINE_WORDS, stageOf, stepsOf, currentStep };
