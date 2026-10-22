import { useEffect, useMemo, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import {
  addPayment,
  addRefund,
  adjustBill,
  checkAdjust,
  clearBillBuyer,
  correctPayment,
  getBill,
  getDues,
  getHeldAdvances,
  getTillOptions,
  putBillOnAccount,
  returnValueOf,
  setBillBuyer,
  voidBill,
} from "../../billing/services/bill.service";
import { listPaymentTypes } from "../../setup/services/restaurant.service";
import { qrSvg, upiPayLink } from "../services/upi";
import { printCountedBill } from "../services/billPrint";
import { printCreditNote, receiptModel } from "../services/receipt";
import { withApproval } from "../../../../services/approval";
import { getErrorMessage } from "../../../../services/api";
import { moneyExact } from "@bmp/shared/format";
import { BILL_PAYMENT_OPTIONS, orderTypeLabel, paymentMethodLabel } from "../../../../services/labels";
import useAuth from "../../../../hooks/useAuth";
import "../../../../styles/billing.css";

// One bill, the same on the POS and on the Bills screen: the bill as it will
// print (every line down to the total, CGST and SGST at their rates), and what
// can be done to it — a coupon, points, a discount given at the till, the
// guest declining service charge, a no-charge bill, a company's GSTIN for a
// B2B invoice, payments, and on the Bills screen refunds, credit notes and
// voids.
//
// Nothing here voids a bill and raises it again: every change re-prices the
// same bill (PATCH /bills/:id/adjust). A change that needs a manager — a
// discount above the till's cap, a no-charge bill, lowering a bill the guest
// already holds on paper — opens the PIN prompt by itself and goes through
// once a manager approves it.

const QUICK_METHODS = ["cash", "card", "upi", "other"];
// Ways a payment can be corrected to (an advance is never a correction).
const CORRECT_METHODS = ["cash", "card", "upi", "online", "wallet", "other"];
const DC_REASONS = ["Regular guest", "Delivery was late", "Wrong or missing item"];
const QUICK_PERCENTS = [5, 10, 15, 20];
const SC_REASONS = ["Guest asked to remove it", "Service was slow", "Food complaint"];

const STATUS = {
  unpaid: { label: "Unpaid", tone: "warning" },
  partial: { label: "Part paid", tone: "info" },
  paid: { label: "Paid", tone: "active" },
  void: { label: "Void", tone: "inactive" },
};

const EMPTY_DISCOUNT = { scope: "bill", type: "percentage", value: "", dishes: {}, reason: "", note: "" };

const n = (value) => Number(value || 0);

// The one method a bill was paid by, when it was paid one way only: what a
// refund goes back by unless the cashier says otherwise.
const onlyMethod = (bill) => {
  const methods = [...new Set((bill.payments || []).map((payment) => payment.paymentMethod))];
  return methods.length === 1 ? methods[0] : "";
};

// Cash a guest is likely to hand over for `amount`: the exact amount, then
// the next round figures above it (₹100, ₹200, ₹500 and ₹2,000 steps), at
// most four buttons.
const cashNotes = (amount) => {
  const list = [Math.round(amount * 100) / 100];

  for (const step of [100, 200, 500, 2000]) {
    const next = Math.ceil(amount / step) * step;

    if (next > amount && !list.includes(next)) {
      list.push(next);
    }
  }

  return list.slice(0, 4);
};

export default function BillModal({
  bill,
  onBill,
  onClose,
  settings,
  currency = "₹",
  mode = "pos",
  customer = null,
  onPaid,
}) {
  const { user, hasPermission, hasFeature } = useAuth();
  const canBill = hasPermission("billing.manage");
  // Restaurant features (Settings -> Features): no tip box without Tips, no
  // "From advance" without Advances, no coupon without Coupons, no points
  // without Loyalty, no account without Guests. The server refuses them too.
  const tipsOn = hasFeature("tips");
  const advancesOn = hasFeature("advances");
  const couponsOn = hasFeature("coupons");
  const guestsOn = hasFeature("guests");
  const canTakePayment = hasPermission("payments.manage");
  const canRefund = hasPermission("payments.manage");

  const [options, setOptions] = useState(null);
  const [panel, setPanel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [payment, setPayment] = useState(() => ({
    method: "cash",
    amount: bill.dueAmount ? String(bill.dueAmount) : "",
    tendered: "",
    reference: "",
    tip: "",
    typeId: "",
    advanceId: "",
  }));
  // The owner's named payment types (meal cards, cheques…), and the guest's
  // advances that still hold money (for "From advance").
  const [paymentTypes, setPaymentTypes] = useState([]);
  const [advances, setAdvances] = useState([]);
  // A payment whose method is being corrected ("I paid by GPay").
  const [fixing, setFixing] = useState(null);
  const [dcReason, setDcReason] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [points, setPoints] = useState("");
  const [discount, setDiscount] = useState(EMPTY_DISCOUNT);
  const [comp, setComp] = useState({ reason: "", note: "" });
  const [scReason, setScReason] = useState("");
  const [buyer, setBuyer] = useState({ gstin: "", legalName: "", address: "" });
  // Guest and company accounts the bill can go on, read when the panel opens.
  const [accounts, setAccounts] = useState(null);
  const [accountsError, setAccountsError] = useState("");
  const [account, setAccount] = useState({ customerId: "", note: "" });
  const [refund, setRefund] = useState(() => ({
    mode: "amount",
    amount: "",
    method: onlyMethod(bill),
    reason: "",
    reversePoints: true,
    returns: {},
  }));
  const [voidReason, setVoidReason] = useState("");

  useEffect(() => {
    getTillOptions()
      .then(setOptions)
      .catch(() => setOptions(null));
    listPaymentTypes()
      .then((rows) => setPaymentTypes(rows.filter((row) => row.status === "active")))
      .catch(() => setPaymentTypes([]));
  }, []);

  const guestId = bill.customerId || bill.accountCustomerId || null;
  const canPay = hasPermission("payments.manage");

  useEffect(() => {
    if (!guestId || !canPay || !advancesOn) {
      return;
    }

    getHeldAdvances(guestId, bill.orderId)
      .then((rows) => {
        setAdvances(rows);
        // A pickup order paid ahead (round 2): its advance is the payment to take first.
        const ahead = rows.find((row) => bill.orderId && Number(row.orderId) === Number(bill.orderId));
        if (ahead && n(bill.dueAmount) > 0) {
          setPayment((current) => ({
            ...current,
            method: "advance",
            tip: "",
            typeId: "",
            advanceId: String(ahead.id),
            amount: String(Math.min(n(bill.dueAmount), n(ahead.heldAmount))),
          }));
        }
      })
      .catch(() => setAdvances([]));
  }, [guestId, canPay, advancesOn, bill.paidAmount, bill.orderId, bill.dueAmount]);

  const model = useMemo(() => receiptModel(bill, { settings: settings || {}, currency }), [bill, settings, currency]);

  const money = (value) => moneyExact(value, currency);
  const unsettled = ["unpaid", "partial"].includes(bill.billStatus);
  const settled = bill.billStatus === "paid";
  const held = n(bill.heldAmount ?? n(bill.paidAmount) - n(bill.refundedAmount));
  const status = STATUS[bill.billStatus] || STATUS.unpaid;
  // The bill sent to the guest's WhatsApp (wa.me: no API, the till's own
  // WhatsApp sends it) when their whole number is on the bill.
  const guestDigits = String(bill.customerMobile || "").replace(/\D/g, "");
  const whatsAppLink =
    guestDigits.length >= 10 && !/x/i.test(bill.customerMobile || "")
      ? `https://wa.me/${guestDigits.length === 10 ? `91${guestDigits}` : guestDigits}?text=${encodeURIComponent(
          `${(model.seller && model.seller.name) || (user && user.restaurantName) || "Your bill"} · Bill ${bill.billNumber} · ${money(bill.totalAmount)}${
            n(bill.dueAmount) > 0 ? ` (${money(bill.dueAmount)} to pay)` : " · paid"
          }. Thank you for dining with us!`
        )}`
      : null;
  const where = [
    orderTypeLabel(bill.orderType),
    bill.tableNo ? `Table ${bill.tableNo}` : null,
    bill.customerName,
    bill.outletName,
  ]
    .filter(Boolean)
    .join(" · ");

  const cap = options ? options.myDiscountLimit : 0;
  const capText = !options
    ? ""
    : !options.canDiscount
      ? "A manager approves discounts with their PIN."
      : cap === null
        ? "You can give any discount yourself."
        : `You can give up to ${cap}% yourself; more needs a manager's PIN.`;

  const pointsAvailable = customer ? n(customer.loyaltyPoints) + n(bill.loyaltyPointsUsed) : n(bill.loyaltyPointsUsed);
  const pointsOn = settings && settings.loyaltyEnabled && hasFeature("guest_loyalty") && bill.customerId && pointsAvailable > 0;

  const open = (next) => {
    setError("");
    setNotice("");
    setPanel((current) => (current === next ? null : next));

    if (next === "account" && accounts === null) {
      getDues()
        .then((data) => {
          const usable = data.accounts.filter((row) => row.hasAccount);
          setAccounts(usable);
          setAccountsError("");
          // The guest on the bill, when they have an account of their own.
          const own = usable.find((row) => Number(row.customerId) === Number(bill.customerId));
          setAccount((current) => ({ ...current, customerId: current.customerId || (own ? String(own.customerId) : "") }));
        })
        .catch((err) => {
          setAccounts([]);
          setAccountsError(getErrorMessage(err));
        });
    }
  };

  // Runs a change; whatever comes back is the bill as it now stands.
  const run = async (work, success) => {
    setBusy(true);
    setError("");
    setNotice("");

    try {
      const updated = await work();

      if (updated) {
        onBill(updated);
        setPayment((current) => ({ ...current, amount: updated.dueAmount ? String(updated.dueAmount) : "" }));
      }

      setNotice(typeof success === "function" ? success(updated) : success);
      setPanel(null);

      return updated;
    } catch (err) {
      setError(getErrorMessage(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  // The change is checked first (reasons, coupon, what it would come to, and
  // whether a manager must approve it). When one must, the PIN prompt opens
  // before anything is sent, tied to the facts the server named, and the
  // change goes out once, already approved — never refused first.
  const change = (payload, label, success) =>
    run(async () => {
      const plan = await checkAdjust(bill.id, payload);

      // Refused (no reason, over the account's limit, past this person's own
      // cap): said here, and nothing is sent.
      if (plan.refused) {
        const refusal = new Error(plan.refused.message);
        refusal.response = { data: { message: plan.refused.message } };
        throw refusal;
      }

      const need = plan.approval;

      return withApproval(
        (headers) => adjustBill(bill.id, payload, headers),
        label,
        need ? { permission: need.permission, scope: need.scope } : {}
      );
    }, success);

  // --------------------------------------------------------------- changes

  const applyCoupon = (event) => {
    event.preventDefault();
    change({ discountCode: couponCode.trim() }, `Coupon on ${bill.billNumber}`, "Coupon applied").then(
      (done) => done && setCouponCode("")
    );
  };

  const applyPoints = (event) => {
    event.preventDefault();
    change({ loyaltyPoints: Number(points) }, `Points on ${bill.billNumber}`, "Points used").then(
      (done) => done && setPoints("")
    );
  };

  const giveDiscount = (event) => {
    event.preventDefault();

    const payload = { discountReason: discount.reason, discountNote: discount.note.trim() || null };

    if (discount.scope === "bill") {
      payload.manualDiscount = { type: discount.type, value: Number(discount.value) };
      payload.itemDiscounts = [];
    } else {
      // The whole set: what was typed, and what a dish already carries.
      payload.manualDiscount = null;
      payload.itemDiscounts = bill.items
        .map((item) => {
          const typed = discount.dishes[item.orderItemId];
          const value =
            typed !== undefined
              ? typed
              : item.itemDiscount && item.itemDiscount.type === discount.type
                ? item.itemDiscount.value
                : "";

          return Number(value) > 0
            ? { orderItemId: item.orderItemId, type: discount.type, value: Number(value) }
            : null;
        })
        .filter(Boolean);
    }

    change(payload, `Discount on ${bill.billNumber}`, (updated) =>
      updated
        ? `Discount given: ${money(n(updated.manualDiscount && updated.manualDiscount.amount) + n(updated.itemDiscountAmount))}`
        : ""
    ).then((done) => done && setDiscount(EMPTY_DISCOUNT));
  };

  const removeDiscount = () =>
    change({ manualDiscount: null, itemDiscounts: [] }, `Remove discount on ${bill.billNumber}`, "Discount taken off");

  const makeComplimentary = (event) => {
    event.preventDefault();
    change(
      { complimentary: { reason: comp.reason, note: comp.note.trim() || null } },
      `No-charge bill ${bill.billNumber}`,
      "The bill is complimentary and settled"
    ).then((done) => {
      if (done && onPaid) {
        onPaid(done);
      }
    });
  };

  const waiveServiceCharge = (event) => {
    event.preventDefault();
    change(
      { serviceCharge: { waive: true, reason: scReason.trim() } },
      `Service charge on ${bill.billNumber}`,
      "Service charge taken off"
    ).then((done) => done && setScReason(""));
  };

  const restoreServiceCharge = () =>
    change({ serviceCharge: { waive: false } }, `Service charge on ${bill.billNumber}`, "Service charge added back");

  const saveBuyer = (event) => {
    event.preventDefault();
    run(async () => {
      await setBillBuyer(bill.id, {
        gstin: buyer.gstin.trim().toUpperCase(),
        legalName: buyer.legalName.trim(),
        address: buyer.address.trim() || null,
      });
      return getBill(bill.id);
    }, "The bill is now a GST invoice to that company");
  };

  // --------------------------------------------------------------- on account

  const chosenAccount = (accounts || []).find((row) => String(row.customerId) === String(account.customerId)) || null;
  const accountRoom = chosenAccount ? n(chosenAccount.available) : 0;
  const fitsAccount = chosenAccount ? n(bill.dueAmount) <= accountRoom + 0.009 : false;

  const putOnAccount = (event) => {
    event.preventDefault();

    if (!chosenAccount) {
      return;
    }

    const payload = { customerId: chosenAccount.customerId, note: account.note.trim() || null };

    run(
      () =>
        withApproval(
          (headers) => putBillOnAccount(bill.id, payload, headers),
          `Put ${money(bill.dueAmount)} on ${chosenAccount.name}'s account`,
          {
            permission: "customers.credit",
            scope: { billId: bill.id, customerId: chosenAccount.customerId, amount: n(bill.dueAmount) },
          }
        ),
      (updated) => (updated ? `${updated.billNumber} is on ${updated.accountName}'s account` : "")
    ).then((done) => {
      if (done) {
        setAccount({ customerId: "", note: "" });
        setAccounts(null);

        if (onPaid) {
          onPaid(done);
        }
      }
    });
  };

  const takeOffAccount = () =>
    run(
      () =>
        withApproval(
          (headers) => putBillOnAccount(bill.id, { customerId: null }, headers),
          `Take ${bill.billNumber} off ${bill.accountName}'s account`,
          { permission: "customers.credit", scope: { billId: bill.id, amount: n(bill.dueAmount) } }
        ),
      "Taken off the account; it is due at the till again"
    );

  const removeBuyer = () =>
    run(async () => {
      await clearBillBuyer(bill.id);
      return getBill(bill.id);
    }, "Company GSTIN taken off the bill");

  // --------------------------------------------------------------- money

  const takePayment = (event) => {
    event.preventDefault();
    const fromAdvance = payment.method === "advance";
    run(
      () =>
        addPayment(bill.id, {
          paymentMethod: payment.method,
          amount: Number(payment.amount),
          tenderedAmount: payment.method === "cash" && payment.tendered ? Number(payment.tendered) : null,
          transactionRef: payment.method !== "cash" && !fromAdvance && payment.reference ? payment.reference : null,
          tipAmount: !fromAdvance && tipsOn && Number(payment.tip) > 0 ? Number(payment.tip) : 0,
          paymentTypeId: !fromAdvance && payment.typeId ? Number(payment.typeId) : null,
          advanceId: fromAdvance ? Number(payment.advanceId) : null,
        }),
      (updated) =>
        updated && updated.billStatus === "paid"
          ? `${updated.billNumber} settled · ${money(updated.totalAmount)}`
          : "Payment recorded"
    ).then((updated) => {
      if (updated) {
        setPayment({
          method: payment.method === "advance" ? "cash" : payment.method,
          amount: updated.dueAmount ? String(updated.dueAmount) : "",
          tendered: "",
          reference: "",
          tip: "",
          typeId: "",
          advanceId: "",
        });

        if (updated.billStatus === "paid" && onPaid) {
          onPaid(updated);
        }
      }
    });
  };

  // Corrects how a payment was taken. The server checks the payment and its
  // day first; a cashier is then asked for a manager's PIN tied to this
  // payment and both methods (the prompt opens by itself from that answer).
  const submitFix = (event) => {
    event.preventDefault();
    const row = bill.payments.find((one) => one.id === fixing.paymentId);
    run(
      () =>
        withApproval(
          (headers) =>
            correctPayment(
              bill.id,
              fixing.paymentId,
              {
                paymentMethod: fixing.method,
                paymentTypeId: fixing.typeId ? Number(fixing.typeId) : null,
                transactionRef: fixing.reference.trim() || null,
                reason: fixing.reason.trim(),
              },
              headers
            ),
          `Change ${money(row ? row.amount : 0)} from ${paymentMethodLabel(row && row.paymentMethod)} to ${paymentMethodLabel(fixing.method)} on ${bill.billNumber}`
        ),
      (updated) => (updated ? `Payment corrected to ${paymentMethodLabel(fixing.method)}` : "")
    ).then((done) => done && setFixing(null));
  };

  const waiveDelivery = (event) => {
    event.preventDefault();
    change(
      { deliveryCharge: { waive: true, reason: dcReason.trim() } },
      `Delivery charge on ${bill.billNumber}`,
      "Delivery charge taken off"
    ).then((done) => done && setDcReason(""));
  };

  const restoreDelivery = () =>
    change({ deliveryCharge: { waive: false } }, `Delivery charge on ${bill.billNumber}`, "Delivery charge put back");

  const returnItems = Object.entries(refund.returns)
    .filter(([, quantity]) => Number(quantity) > 0)
    .map(([orderItemId, quantity]) => ({ orderItemId: Number(orderItemId), quantity: Number(quantity) }));
  const returnWorth =
    Math.round(
      returnItems.reduce((sum, row) => {
        const item = bill.items.find((one) => Number(one.orderItemId) === row.orderItemId);
        return sum + Math.round(returnValueOf(item, row.quantity) * 100);
      }, 0)
    ) / 100;
  const refundAmount = settled && refund.mode === "dishes" ? returnWorth : Number(refund.amount);

  const giveRefund = (event) => {
    event.preventDefault();

    const payload = {
      amount: refundAmount,
      refundMethod: refund.method || null,
      reason: refund.reason.trim(),
      reversePoints: refund.reversePoints,
      ...(settled && refund.mode === "dishes" ? { items: returnItems } : {}),
    };

    run(
      async () => {
        const result = await withApproval(
          (headers) => addRefund(bill.id, payload, headers),
          `Refund ${money(refundAmount)} on bill ${bill.billNumber}`,
          { permission: "bills.refund", scope: { billId: bill.id, amount: refundAmount } }
        );
        return result.data;
      },
      (updated) => {
        const note = updated && updated.creditNotes && updated.creditNotes[updated.creditNotes.length - 1];
        return settled && note ? `Refund recorded · credit note ${note.number}` : "The payment was handed back";
      }
    ).then(
      (done) =>
        done &&
        setRefund({
          mode: "amount",
          amount: "",
          method: onlyMethod(done),
          reason: "",
          reversePoints: true,
          returns: {},
        })
    );
  };

  const submitVoid = (event) => {
    event.preventDefault();
    run(
      () =>
        withApproval((headers) => voidBill(bill.id, voidReason.trim(), headers), `Void bill ${bill.billNumber}`, {
          permission: "bills.void",
          scope: { billId: bill.id },
        }),
      "Bill voided; the order is open again"
    ).then((done) => done && setVoidReason(""));
  };

  const print = () =>
    run(
      () => printCountedBill(bill, { settings, currency }),
      (printed) =>
        printed && printed.copy === "duplicate" ? `Printed as a duplicate (copy ${printed.printCount - 1})` : "Printed"
    );

  // --------------------------------------------------------------- pieces

  const chip = (key, icon, label, active) => (
    <button
      type="button"
      className={`bill-action ${panel === key ? "is-open" : ""} ${active ? "is-set" : ""}`}
      onClick={() => open(key)}
      aria-expanded={panel === key}
    >
      <Icon name={icon} size={15} /> {label}
    </button>
  );

  const hasTillDiscount = Boolean(bill.manualDiscount) || n(bill.itemDiscountAmount) > 0;

  const actions = unsettled && canBill && (
    <div className="bill-actions" role="group" aria-label="Change the bill">
      {(couponsOn || bill.discountCode) &&
        chip("coupon", "tag", bill.discountCode ? `Coupon ${bill.discountCode}` : "Coupon", Boolean(bill.discountCode))}
      {pointsOn &&
        chip(
          "points",
          "gift",
          bill.loyaltyPointsUsed ? `${bill.loyaltyPointsUsed} points` : "Points",
          n(bill.loyaltyPointsUsed) > 0
        )}
      {chip("discount", "percent", hasTillDiscount ? "Discount given" : "Discount", hasTillDiscount)}
      {(n(bill.serviceCharge) > 0 || bill.serviceChargeWaived) &&
        chip(
          "service",
          "users",
          bill.serviceChargeWaived ? "Service charge off" : "Service charge",
          bill.serviceChargeWaived
        )}
      {bill.orderType === "delivery" &&
        (n(bill.deliveryCharge) > 0 || bill.deliveryChargeWaived) &&
        chip(
          "delivery",
          "truck",
          bill.deliveryChargeWaived ? "Delivery charge off" : "Delivery charge",
          bill.deliveryChargeWaived
        )}
      {chip("comp", "sparkles", "No charge", false)}
      {chip("buyer", "file", bill.buyer ? "Company GSTIN ✓" : "Company GSTIN", Boolean(bill.buyer))}
      {n(bill.dueAmount) > 0 &&
        (guestsOn || bill.accountCustomerId) &&
        chip("account", "users", bill.accountCustomerId ? "On account ✓" : "On account", Boolean(bill.accountCustomerId))}
    </div>
  );

  const reasonSelect = (list, value, onChange, id) => (
    <select id={id} value={value} onChange={onChange} required>
      <option value="">Choose a reason…</option>
      {(list || []).map((reason) => (
        <option key={reason.value} value={reason.value}>
          {reason.label}
        </option>
      ))}
    </select>
  );

  const panels = {
    coupon: (
      <form className="bill-panel" onSubmit={applyCoupon}>
        {bill.discountCode ? (
          <div className="bill-panel-row">
            <span>
              <strong>{bill.discountCode}</strong> takes off {money(bill.couponDiscount)}
            </span>
            <button
              type="button"
              className="button button-ghost button-sm"
              onClick={() => change({ discountCode: null }, `Coupon on ${bill.billNumber}`, "Coupon taken off")}
              disabled={busy}
            >
              Remove
            </button>
          </div>
        ) : null}
        <div className="bill-panel-row">
          <input
            aria-label="Coupon code"
            placeholder="Coupon code"
            value={couponCode}
            onChange={(event) => setCouponCode(event.target.value.toUpperCase())}
            autoFocus
          />
          <button type="submit" className="button button-sm" disabled={busy || !couponCode.trim()}>
            {bill.discountCode ? "Change" : "Apply"}
          </button>
        </div>
      </form>
    ),
    points: (
      <form className="bill-panel" onSubmit={applyPoints}>
        <p className="muted small">
          {customer ? `${customer.name || "The guest"} has` : "Available:"} {pointsAvailable} points
          {settings && settings.loyaltyPointValue ? ` · 1 point = ${money(settings.loyaltyPointValue)}` : ""}
          {settings && settings.loyaltyMinRedeem ? ` · at least ${settings.loyaltyMinRedeem} at a time` : ""}
        </p>
        <div className="bill-panel-row">
          <input
            type="number"
            min="1"
            max={pointsAvailable}
            step="1"
            aria-label="Points to use"
            placeholder="Points"
            value={points}
            onChange={(event) => setPoints(event.target.value)}
          />
          <button type="submit" className="button button-sm" disabled={busy || !points}>
            Use points
          </button>
          {n(bill.loyaltyPointsUsed) > 0 && (
            <button
              type="button"
              className="button button-ghost button-sm"
              onClick={() => change({ loyaltyPoints: 0 }, `Points on ${bill.billNumber}`, "Points given back")}
              disabled={busy}
            >
              Give back
            </button>
          )}
        </div>
      </form>
    ),
    discount: (
      <form className="bill-panel" onSubmit={giveDiscount}>
        {hasTillDiscount && (
          <div className="bill-panel-row bill-panel-current">
            <span>
              Given now:{" "}
              <strong>
                {money(n(bill.manualDiscount && bill.manualDiscount.amount) + n(bill.itemDiscountAmount))}
              </strong>
              {bill.discountReasonLabel ? ` · ${bill.discountReasonLabel}` : ""}
              {bill.discountGivenBy ? ` · by ${bill.discountGivenBy}` : ""}
              {bill.discountApprovedBy ? `, approved by ${bill.discountApprovedBy}` : ""}
            </span>
            <button type="button" className="button button-ghost button-sm" onClick={removeDiscount} disabled={busy}>
              Remove
            </button>
          </div>
        )}
        <div className="bill-panel-row">
          <div className="segmented" role="radiogroup" aria-label="Discount on">
            {[
              ["bill", "Whole bill"],
              ["dishes", "Some dishes"],
            ].map(([value, label]) => (
              <button
                type="button"
                key={value}
                role="radio"
                aria-checked={discount.scope === value}
                className={`segment ${discount.scope === value ? "is-active" : ""}`}
                onClick={() => setDiscount({ ...discount, scope: value })}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="segmented" role="radiogroup" aria-label="Discount as">
            {[
              ["percentage", "%"],
              ["amount", currency],
            ].map(([value, label]) => (
              <button
                type="button"
                key={value}
                role="radio"
                aria-checked={discount.type === value}
                className={`segment ${discount.type === value ? "is-active" : ""}`}
                onClick={() => setDiscount({ ...discount, type: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {discount.scope === "bill" ? (
          <div className="bill-panel-row">
            <input
              type="number"
              min="0.01"
              step="0.01"
              max={discount.type === "percentage" ? 100 : undefined}
              aria-label={discount.type === "percentage" ? "Percent off the bill" : "Amount off the bill"}
              placeholder={discount.type === "percentage" ? "% off" : `${currency} off`}
              value={discount.value}
              onChange={(event) => setDiscount({ ...discount, value: event.target.value })}
              required
            />
            {discount.type === "percentage" &&
              QUICK_PERCENTS.map((value) => (
                <button
                  type="button"
                  key={value}
                  className="chip-button"
                  onClick={() => setDiscount({ ...discount, value: String(value) })}
                >
                  {value}%
                </button>
              ))}
          </div>
        ) : (
          <ul className="bill-dish-discounts">
            {bill.items.map((item) => (
              <li key={item.orderItemId}>
                <span>
                  {item.itemName}
                  {item.variantName ? ` (${item.variantName})` : ""} × {item.quantity}
                  <span className="muted small"> · {money(item.lineSubtotal)}</span>
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  aria-label={`Discount on ${item.itemName}`}
                  placeholder={discount.type === "percentage" ? "%" : currency}
                  value={
                    discount.dishes[item.orderItemId] ??
                    (item.itemDiscount && item.itemDiscount.type === discount.type
                      ? String(item.itemDiscount.value)
                      : "")
                  }
                  onChange={(event) =>
                    setDiscount({ ...discount, dishes: { ...discount.dishes, [item.orderItemId]: event.target.value } })
                  }
                />
              </li>
            ))}
          </ul>
        )}

        <label className="field">
          <span>Reason *</span>
          {reasonSelect(
            options && options.discountReasons,
            discount.reason,
            (event) => setDiscount({ ...discount, reason: event.target.value }),
            "bill-discount-reason"
          )}
        </label>
        <label className="field">
          <span>Note{discount.reason === "other" ? " *" : ""}</span>
          <input
            value={discount.note}
            maxLength={200}
            onChange={(event) => setDiscount({ ...discount, note: event.target.value })}
            placeholder="What happened, for the owner"
            required={discount.reason === "other"}
          />
        </label>
        {capText && <p className="muted small">{capText}</p>}
        <div className="bill-panel-row bill-panel-end">
          <button type="submit" className="button button-sm" disabled={busy || !discount.reason}>
            Give discount
          </button>
        </div>
      </form>
    ),
    service: bill.serviceChargeWaived ? (
      <div className="bill-panel">
        <p className="small">
          Service charge was taken off{bill.serviceChargeWaiveReason ? `: “${bill.serviceChargeWaiveReason}”` : ""}.
        </p>
        <div className="bill-panel-row bill-panel-end">
          <button
            type="button"
            className="button button-secondary button-sm"
            onClick={restoreServiceCharge}
            disabled={busy}
          >
            Add it back
          </button>
        </div>
      </div>
    ) : (
      <form className="bill-panel" onSubmit={waiveServiceCharge}>
        <p className="muted small">
          Service charge is voluntary: a guest who asks can have it taken off. Its GST comes off with it.
        </p>
        <div className="bill-panel-row bill-chips">
          {SC_REASONS.map((reason) => (
            <button
              type="button"
              key={reason}
              className={`chip-button ${scReason === reason ? "is-active" : ""}`}
              onClick={() => setScReason(reason)}
            >
              {reason}
            </button>
          ))}
        </div>
        <div className="bill-panel-row">
          <input
            aria-label="Why it is taken off"
            placeholder="Why (the guest's reason)"
            value={scReason}
            maxLength={200}
            onChange={(event) => setScReason(event.target.value)}
            required
          />
          <button type="submit" className="button button-sm" disabled={busy || !scReason.trim()}>
            Take off {money(bill.serviceCharge)}
          </button>
        </div>
      </form>
    ),
    delivery: bill.deliveryChargeWaived ? (
      <div className="bill-panel">
        <p className="small">
          The delivery charge was taken off{bill.deliveryChargeWaiveReason ? `: “${bill.deliveryChargeWaiveReason}”` : ""}
          {bill.deliveryChargeWaivedBy ? ` · by ${bill.deliveryChargeWaivedBy}` : ""}
          {bill.deliveryChargeApprovedBy ? `, approved by ${bill.deliveryChargeApprovedBy}` : ""}.
        </p>
        <div className="bill-panel-row bill-panel-end">
          <button type="button" className="button button-secondary button-sm" onClick={restoreDelivery} disabled={busy}>
            Put it back
          </button>
        </div>
      </div>
    ) : (
      <form className="bill-panel" onSubmit={waiveDelivery}>
        <p className="muted small">
          Own delivery&apos;s trip charge ({money(bill.deliveryCharge)} + its GST). Taking it off needs a manager
          {hasPermission("orders.waive_delivery_charge") ? "" : " (they approve with their PIN)"} and a reason.
        </p>
        <div className="bill-panel-row bill-chips">
          {DC_REASONS.map((reason) => (
            <button
              type="button"
              key={reason}
              className={`chip-button ${dcReason === reason ? "is-active" : ""}`}
              onClick={() => setDcReason(reason)}
            >
              {reason}
            </button>
          ))}
        </div>
        <div className="bill-panel-row">
          <input
            aria-label="Why the delivery charge is taken off"
            placeholder="Why"
            value={dcReason}
            maxLength={200}
            onChange={(event) => setDcReason(event.target.value)}
            required
          />
          <button type="submit" className="button button-sm" disabled={busy || !dcReason.trim()}>
            Take off {money(bill.deliveryCharge)}
          </button>
        </div>
      </form>
    ),
    comp: (
      <form className="bill-panel" onSubmit={makeComplimentary}>
        <p className="muted small">
          Every dish at 100% off, nothing to collect, and the bill settles. The ingredients still leave stock, and the
          owner sees it on the “given at the till” list.
          {options && !options.canComplimentary ? " A manager approves it with their PIN." : ""}
        </p>
        <label className="field">
          <span>Reason *</span>
          {reasonSelect(
            options && options.complimentaryReasons,
            comp.reason,
            (event) => setComp({ ...comp, reason: event.target.value }),
            "bill-comp-reason"
          )}
        </label>
        <label className="field">
          <span>Note{comp.reason === "other" ? " *" : ""}</span>
          <input
            value={comp.note}
            maxLength={200}
            onChange={(event) => setComp({ ...comp, note: event.target.value })}
            required={comp.reason === "other"}
          />
        </label>
        <div className="bill-panel-row bill-panel-end">
          <button type="submit" className="button button-danger button-sm" disabled={busy || !comp.reason || held > 0}>
            Make it no-charge ({money(bill.subtotal)})
          </button>
        </div>
        {held > 0 && <p className="small text-danger">Money is already paid on this bill. Give it back first.</p>}
      </form>
    ),
    buyer: (
      <form className="bill-panel" onSubmit={saveBuyer}>
        {bill.buyer && (
          <div className="bill-panel-row bill-panel-current">
            <span>
              <strong>{bill.buyer.legalName}</strong> · <span className="mono">{bill.buyer.gstin}</span>
            </span>
            <button type="button" className="button button-ghost button-sm" onClick={removeBuyer} disabled={busy}>
              Remove
            </button>
          </div>
        )}
        <p className="muted small">
          For a guest claiming GST input credit: their company's GSTIN and registered name print on the invoice.
        </p>
        <label className="field">
          <span>GSTIN *</span>
          <input
            className="mono"
            value={buyer.gstin}
            maxLength={15}
            placeholder="37AAACR5055K1Z6"
            onChange={(event) => setBuyer({ ...buyer, gstin: event.target.value.toUpperCase() })}
            required
          />
        </label>
        <label className="field">
          <span>Registered name *</span>
          <input
            value={buyer.legalName}
            maxLength={150}
            onChange={(event) => setBuyer({ ...buyer, legalName: event.target.value })}
            required
          />
        </label>
        <label className="field">
          <span>Address</span>
          <input
            value={buyer.address}
            maxLength={300}
            placeholder="Billing address, as on their GST registration"
            onChange={(event) => setBuyer({ ...buyer, address: event.target.value })}
          />
          <small className="muted">The state is read from the GSTIN.</small>
        </label>
        <div className="bill-panel-row bill-panel-end">
          <button type="submit" className="button button-sm" disabled={busy}>
            {bill.buyer ? "Change company" : "Put on the invoice"}
          </button>
        </div>
      </form>
    ),
    account: bill.accountCustomerId ? (
      <div className="bill-panel">
        <div className="bill-panel-row bill-panel-current">
          <span>
            On <strong>{bill.accountName}</strong>&apos;s account · {money(bill.dueAmount)} due
            {bill.accountBy ? ` · by ${bill.accountBy}` : ""}
            {bill.accountApprovedBy ? `, approved by ${bill.accountApprovedBy}` : ""}
          </span>
        </div>
        <p className="muted small">
          It is collected under Dues &amp; accounts, or here with Take payment. Put on the wrong account? Take it off and
          put it on the right one.
        </p>
        <div className="bill-panel-row bill-panel-end">
          <button type="button" className="button button-secondary button-sm" onClick={takeOffAccount} disabled={busy}>
            Take off the account
          </button>
        </div>
      </div>
    ) : (
      <form className="bill-panel" onSubmit={putOnAccount}>
        <p className="muted small">
          For a regular or a company that settles later: the bill goes on their account instead of being paid now, the
          table is freed, and the amount shows on the dues list until it is collected.
          {!hasPermission("customers.credit") ? " A manager approves it with their PIN." : ""}
        </p>
        {accounts === null ? (
          <p className="muted small">Reading the accounts…</p>
        ) : accountsError ? (
          <p className="small text-danger">{accountsError}</p>
        ) : accounts.length === 0 ? (
          <p className="small">
            Nobody has an account yet. The owner opens one (with a credit limit) under Dues &amp; accounts.
          </p>
        ) : (
          <>
            <label className="field">
              <span>Account *</span>
              <select
                value={account.customerId}
                onChange={(event) => setAccount({ ...account, customerId: event.target.value })}
                required
              >
                <option value="">Choose a guest or company…</option>
                {accounts.map((row) => (
                  <option key={row.customerId} value={row.customerId} disabled={row.status !== "active"}>
                    {row.name} · {money(row.available)} left of {money(row.creditLimit)}
                    {row.status !== "active" ? " (on hold)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {chosenAccount && (
              <p className={`small ${fitsAccount ? "muted" : "text-danger"}`}>
                Owes {money(chosenAccount.outstanding)} now
                {fitsAccount
                  ? ` · ${money(accountRoom - n(bill.dueAmount))} left after this bill`
                  : ` · this bill (${money(bill.dueAmount)}) would take it over the ${money(chosenAccount.creditLimit)} limit`}
              </p>
            )}
            <label className="field">
              <span>Note</span>
              <input
                value={account.note}
                maxLength={200}
                placeholder="Who signed for it, PO number…"
                onChange={(event) => setAccount({ ...account, note: event.target.value })}
              />
            </label>
            <div className="bill-panel-row bill-panel-end">
              <button type="submit" className="button button-sm" disabled={busy || !chosenAccount || !fitsAccount}>
                Put {money(bill.dueAmount)} on account
              </button>
            </div>
          </>
        )}
      </form>
    ),
  };

  const fromAdvance = payment.method === "advance";
  const typesHere = paymentTypes.filter((type) => type.paymentMethod === payment.method);
  const chosenType = typesHere.find((type) => String(type.id) === String(payment.typeId)) || null;
  const chosenAdvance = advances.find((row) => String(row.id) === String(payment.advanceId)) || null;
  const tip = fromAdvance || !tipsOn ? 0 : Math.max(0, Number(payment.tip) || 0);
  const changeDue =
    payment.method === "cash" && payment.tendered ? Number(payment.tendered) - Number(payment.amount || 0) - tip : 0;
  // The UPI QR for exactly what is being taken now (the whole due, or a part).
  const upiLink =
    payment.method === "upi" && bill.upi
      ? upiPayLink({ vpa: bill.upi.vpa, payeeName: bill.upi.payeeName, amount: payment.amount, note: bill.billNumber })
      : null;
  const pickMethod = (method) =>
    setPayment((current) => ({
      ...current,
      method,
      typeId: "",
      tip: method === "advance" ? "" : current.tip,
      advanceId: method === "advance" && advances.length === 1 ? String(advances[0].id) : "",
      amount:
        method === "advance" && advances.length === 1
          ? String(Math.min(n(bill.dueAmount), n(advances[0].heldAmount)))
          : current.amount,
    }));

  const paymentForm = unsettled && canTakePayment && (
    <form className="bill-pay" onSubmit={takePayment}>
      <div className="bill-pay-head">
        <span>Take payment</span>
        <strong>{money(bill.dueAmount)} due</strong>
      </div>
      <div className="segmented bill-methods" role="radiogroup" aria-label="Payment method">
        {[...QUICK_METHODS, ...(advancesOn && advances.length > 0 ? ["advance"] : [])].map((method) => (
          <button
            type="button"
            key={method}
            role="radio"
            aria-checked={payment.method === method}
            className={`segment ${payment.method === method ? "is-active" : ""}`}
            onClick={() => pickMethod(method)}
          >
            {method === "advance" ? "Advance" : paymentMethodLabel(method)}
          </button>
        ))}
      </div>
      {fromAdvance && (
        <label className="field">
          <span>Pay from *</span>
          <select
            value={payment.advanceId}
            onChange={(event) => {
              const picked = advances.find((row) => String(row.id) === event.target.value);
              setPayment({
                ...payment,
                advanceId: event.target.value,
                amount: picked ? String(Math.min(n(bill.dueAmount), n(picked.heldAmount))) : payment.amount,
              });
            }}
            required
          >
            <option value="">Choose the advance…</option>
            {advances.map((row) => (
              <option key={row.id} value={row.id}>
                {row.receiptNumber} · {money(row.heldAmount)} left{row.purpose ? ` · ${row.purpose}` : ""}
              </option>
            ))}
          </select>
          {chosenAdvance && (
            <small className="muted">
              {Number(payment.amount) < n(chosenAdvance.heldAmount)
                ? `${money(n(chosenAdvance.heldAmount) - Number(payment.amount || 0))} stays on the advance`
                : "Uses all of it"}
            </small>
          )}
        </label>
      )}
      {!fromAdvance && typesHere.length > 0 && (
        <label className="field">
          <span>Type</span>
          <select value={payment.typeId} onChange={(event) => setPayment({ ...payment, typeId: event.target.value })}>
            <option value="">{paymentMethodLabel(payment.method)} (no particular type)</option>
            {typesHere.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
                {type.needsReference ? " (reference needed)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="bill-pay-fields">
        <label className="field">
          <span>Amount *</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            max={fromAdvance && chosenAdvance ? Math.min(n(bill.dueAmount), n(chosenAdvance.heldAmount)) : undefined}
            value={payment.amount}
            onChange={(event) => setPayment({ ...payment, amount: event.target.value })}
            required
          />
        </label>
        {payment.method === "cash" ? (
          <label className="field">
            <span>Cash given</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={payment.tendered}
              onChange={(event) => setPayment({ ...payment, tendered: event.target.value })}
            />
            {/* The notes a guest usually hands over: the exact amount and the
                next round notes above it, one tap each. */}
            {Number(payment.amount) > 0 && (
              <span className="bill-notes" role="group" aria-label="Cash given">
                {cashNotes(Number(payment.amount)).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`chip-button bill-note ${Number(payment.tendered) === value ? "is-active" : ""}`}
                    onClick={() => setPayment({ ...payment, tendered: String(value) })}
                  >
                    {value === Number(payment.amount) ? "Exact" : money(value).replace(/\.00$/, "")}
                  </button>
                ))}
              </span>
            )}
            {changeDue > 0.004 && (
              <strong className="bill-change bill-change-big" role="status">
                Return {money(changeDue)}
              </strong>
            )}
            {payment.tendered && changeDue < -0.004 && (
              <small className="text-danger">Short by {money(-changeDue)}</small>
            )}
          </label>
        ) : fromAdvance ? null : (
          <label className="field">
            <span>Reference{chosenType && chosenType.needsReference ? " *" : ""}</span>
            <input
              value={payment.reference}
              maxLength={100}
              placeholder={chosenType ? `${chosenType.name} slip / number` : "UTR / card slip"}
              onChange={(event) => setPayment({ ...payment, reference: event.target.value })}
              required={Boolean(chosenType && chosenType.needsReference)}
            />
          </label>
        )}
        {!fromAdvance && tipsOn && (
          <label className="field">
            <span>Tip</span>
            <input
              type="number"
              min="0"
              step="1"
              placeholder="0"
              aria-describedby="bill-tip-hint"
              value={payment.tip}
              onChange={(event) => setPayment({ ...payment, tip: event.target.value })}
            />
            <small id="bill-tip-hint" className="muted">
              On top of the bill, for the staff
            </small>
          </label>
        )}
      </div>
      {upiLink && (
        <div className="bill-upi">
          <div className="bill-upi-code" dangerouslySetInnerHTML={{ __html: qrSvg(upiLink, { label: "UPI QR code" }) }} />
          <div className="bill-upi-text">
            <strong>Scan to pay {money(payment.amount || 0)}</strong>
            <span className="muted small">{bill.upi.vpa}</span>
            <span className="muted small">
              Any UPI app. When it shows as paid, write the UTR above and take the payment.
            </span>
          </div>
        </div>
      )}
      {payment.method === "upi" && !bill.upi && (
        <p className="muted small">Add the restaurant&apos;s UPI ID in Settings to show a QR code here.</p>
      )}
      <button
        type="submit"
        className="button bill-pay-button"
        disabled={busy || !(Number(payment.amount) > 0) || (fromAdvance && !payment.advanceId)}
      >
        {busy ? "Saving…" : `Take ${money(payment.amount || 0)}${tip > 0 ? ` + ${money(tip)} tip` : ""}`}
      </button>
    </form>
  );

  // A cash payment that gave change can only stay cash (the change came out
  // of the drawer): its reference can still be corrected.
  const fixRow = fixing ? bill.payments.find((one) => one.id === fixing.paymentId) || null : null;
  const fixMethods = fixRow && fixRow.changeAmount > 0 ? ["cash"] : CORRECT_METHODS;

  const fixForm = fixing && (
    <form className="bill-panel bill-fix" onSubmit={submitFix}>
      <p className="small">
        <strong>Correct how this payment was taken.</strong> Only the method changes: the bill, its GST and the sales
        stay as they are.
        {hasPermission("bills.payment_correct") ? "" : " A manager approves it with their PIN."}
      </p>
      <div className="bill-pay-fields">
        <label className="field">
          <span>Really paid by *</span>
          <select
            value={fixing.method}
            onChange={(event) => setFixing({ ...fixing, method: event.target.value, typeId: "" })}
            required
          >
            {fixMethods.map((method) => (
              <option key={method} value={method}>
                {paymentMethodLabel(method)}
              </option>
            ))}
          </select>
          {fixRow && fixRow.changeAmount > 0 && (
            <small className="muted">Change was handed back in cash, so it stays cash.</small>
          )}
        </label>
        {paymentTypes.some((type) => type.paymentMethod === fixing.method) && (
          <label className="field">
            <span>Type</span>
            <select value={fixing.typeId} onChange={(event) => setFixing({ ...fixing, typeId: event.target.value })}>
              <option value="">None</option>
              {paymentTypes
                .filter((type) => type.paymentMethod === fixing.method)
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Reference</span>
          <input
            value={fixing.reference}
            maxLength={100}
            placeholder="UTR / slip"
            onChange={(event) => setFixing({ ...fixing, reference: event.target.value })}
          />
        </label>
      </div>
      <label className="field">
        <span>Reason *</span>
        <input
          value={fixing.reason}
          maxLength={200}
          placeholder="Guest paid by GPay, keyed as cash"
          onChange={(event) => setFixing({ ...fixing, reason: event.target.value })}
          required
        />
      </label>
      <div className="bill-panel-row bill-panel-end">
        <button type="button" className="button button-ghost button-sm" onClick={() => setFixing(null)} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="button button-sm" disabled={busy || !fixing.reason.trim()}>
          Save correction
        </button>
      </div>
    </form>
  );

  const refundForm = mode === "bills" && canRefund && held > 0 && (
    <form className="bill-panel" onSubmit={giveRefund}>
      <p className="small">
        {settled ? (
          <>
            <strong>Refund with a credit note.</strong> The money goes back and a credit note takes it, and its GST, off
            the sale.
          </>
        ) : (
          <>
            <strong>Hand back a payment.</strong> The bill is not settled, so the guest will owe this again.
          </>
        )}
      </p>
      {settled && (
        <div className="segmented" role="radiogroup" aria-label="Refund as">
          {[
            ["amount", "An amount"],
            ["dishes", "Dishes returned"],
          ].map(([value, label]) => (
            <button
              type="button"
              key={value}
              role="radio"
              aria-checked={refund.mode === value}
              className={`segment ${refund.mode === value ? "is-active" : ""}`}
              onClick={() => setRefund({ ...refund, mode: value })}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {settled && refund.mode === "dishes" ? (
        <ul className="bill-dish-discounts">
          {bill.items
            .filter((item) => item.returnableQuantity > 0)
            .map((item) => (
              <li key={item.orderItemId}>
                <span>
                  {item.itemName}
                  {item.variantName ? ` (${item.variantName})` : ""}
                  <span className="muted small">
                    {" "}
                    · {item.returnableQuantity} left · {money(item.returnValue)} each
                  </span>
                </span>
                <input
                  type="number"
                  min="0"
                  max={item.returnableQuantity}
                  step="1"
                  aria-label={`How many ${item.itemName} returned`}
                  placeholder="0"
                  value={refund.returns[item.orderItemId] || ""}
                  onChange={(event) =>
                    setRefund({ ...refund, returns: { ...refund.returns, [item.orderItemId]: event.target.value } })
                  }
                />
              </li>
            ))}
          {bill.items.every((item) => !(item.returnableQuantity > 0)) && (
            <li className="muted small">Nothing on this bill can be returned.</li>
          )}
        </ul>
      ) : null}
      <div className="bill-pay-fields">
        <label className="field">
          <span>Amount *</span>
          {settled && refund.mode === "dishes" ? (
            <input value={money(returnWorth)} readOnly aria-readonly="true" />
          ) : (
            <input
              type="number"
              min="0.01"
              step="0.01"
              max={held}
              value={refund.amount}
              onChange={(event) => setRefund({ ...refund, amount: event.target.value })}
              required
            />
          )}
          <small className="muted">Up to {money(held)}</small>
        </label>
        <label className="field">
          <span>Paid back by *</span>
          <select
            value={refund.method}
            onChange={(event) => setRefund({ ...refund, method: event.target.value })}
            required
          >
            <option value="">Choose…</option>
            {BILL_PAYMENT_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Reason *</span>
        <input
          value={refund.reason}
          maxLength={200}
          onChange={(event) => setRefund({ ...refund, reason: event.target.value })}
          placeholder="What went wrong"
          required
        />
      </label>
      {settled && bill.customerId && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={refund.reversePoints}
            onChange={(event) => setRefund({ ...refund, reversePoints: event.target.checked })}
          />
          <span>Take back the points earned on this money</span>
        </label>
      )}
      <div className="bill-panel-row bill-panel-end">
        <button
          type="submit"
          className="button button-secondary button-sm"
          disabled={busy || !(refundAmount > 0) || !refund.method || !refund.reason.trim()}
        >
          {refundAmount > 0
            ? `${settled ? "Refund" : "Hand back"} ${money(refundAmount)}`
            : settled
              ? "Refund"
              : "Hand back"}
        </button>
      </div>
    </form>
  );

  // A bill put on an account has closed its order and freed the table; it is
  // collected on the account, never voided (the server says the same).
  const voidForm = mode === "bills" && canBill && unsettled && held <= 0 && !bill.accountCustomerId && (
    <form className="bill-panel" onSubmit={submitVoid}>
      <p className="small muted">
        For a bill raised by mistake. The order opens again, the coupon's use and any points go back.
      </p>
      <div className="bill-panel-row">
        <input
          aria-label="Reason for voiding"
          placeholder="Reason for voiding"
          value={voidReason}
          maxLength={200}
          onChange={(event) => setVoidReason(event.target.value)}
          required
        />
        <button type="submit" className="button button-danger button-sm" disabled={busy || !voidReason.trim()}>
          Void bill
        </button>
      </div>
    </form>
  );

  return (
    <Modal
      title={`${bill.billNumber} · ${bill.orderNumber}`}
      description={where}
      icon="receipt"
      onClose={onClose}
      width={880}
    >
      <div className="bill-modal">
        <div className="bill-flags">
          <span className={`badge badge-${status.tone} status-badge`}>
            <span className="badge-dot" />
            {status.label}
          </span>
          {bill.isComplimentary && (
            <span className="badge badge-primary">No charge · {bill.complimentaryReasonLabel}</span>
          )}
          {bill.printCount > 0 ? (
            <span className={`badge ${bill.printCount > 1 ? "badge-warning" : "badge-neutral"}`}>
              Printed {bill.printCount}×
            </span>
          ) : (
            <span className="badge badge-outline">Not printed</span>
          )}
          {bill.buyer && <span className="badge badge-info">B2B · {bill.buyer.gstin}</span>}
          {bill.accountCustomerId && <span className="badge badge-warning">On account · {bill.accountName}</span>}
          {bill.creditNotes && bill.creditNotes.length > 0 && (
            <span className="badge badge-danger">
              {bill.creditNotes.length} credit note{bill.creditNotes.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        <ErrorMessage message={error} />
        <SuccessMessage message={notice} />

        <div className="bill-grid">
          <section className="bill-paper" aria-label="The bill as it prints">
            <div className="bill-paper-title">
              <span>{model.title}</span>
              <span className="muted small">{bill.businessDate || ""}</span>
            </div>
            {(model.buyer || model.guest) && (
              <p className="bill-paper-to small">
                {model.buyer ? (
                  <>
                    To <strong>{model.buyer.legalName}</strong> · GSTIN <span className="mono">{model.buyer.gstin}</span>
                    {model.buyer.address ? (
                      <>
                        <br />
                        <span className="muted">{model.buyer.address}</span>
                      </>
                    ) : null}
                  </>
                ) : (
                  <>Guest: {model.guest.name}</>
                )}
              </p>
            )}
            <table className="bill-lines">
              <thead>
                <tr>
                  <th>Dish</th>
                  <th className="right">Qty</th>
                  <th className="right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {model.items.map((item, index) => (
                  <tr key={index} className={item.discount ? "has-discount" : ""}>
                    <td>
                      {item.name}
                      {item.discount ? (
                        <span className="bill-line-discount">
                          {item.discountLabel} · −{money(item.discount)}
                        </span>
                      ) : null}
                    </td>
                    <td className="right">{item.quantity}</td>
                    <td className="right">{money(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="bill-sums">
              {model.totals.map((row, index) => (
                <div key={`${row.key}-${index}`} className={`bill-sum is-${row.key}`}>
                  <dt>{row.label}</dt>
                  <dd>
                    {row.key !== "subtotal" &&
                    row.key !== "total" &&
                    row.key !== "paid" &&
                    row.key !== "due" &&
                    row.amount < 0
                      ? `−${money(-row.amount)}`
                      : money(row.amount)}
                  </dd>
                </div>
              ))}
            </dl>
            {model.notes.map((note) => (
              <p key={note} className="muted small bill-note">
                {note}
              </p>
            ))}
          </section>

          <section className="bill-side">
            {actions}
            {panel && panels[panel]}
            {paymentForm}

            {settled && (
              <div className="alert alert-success">
                {bill.isComplimentary
                  ? "No charge — settled. The table is free again."
                  : n(bill.creditedAmount) > 0
                    ? `Paid. ${money(bill.creditedAmount)} was given back by credit note.`
                    : "Paid in full."}
              </div>
            )}
            {bill.billStatus === "void" && (
              <div className="alert">Void{bill.voidReason ? `: ${bill.voidReason}` : ""}</div>
            )}

            {bill.paymentDetailsHidden && (
              <p className="muted small">How this bill was paid is for the cashier and the manager.</p>
            )}

            {(bill.payments.length > 0 || bill.refunds.length > 0) && (
              <div className="bill-history">
                <h3>Money on this bill</h3>
                <ul>
                  {bill.payments.map((row) => (
                    <li key={`p${row.id}`}>
                      <span>
                        <Icon
                          name={
                            row.paymentMethod === "cash" ? "cash" : row.paymentMethod === "card" ? "card" : "wallet"
                          }
                          size={14}
                        />{" "}
                        {paymentMethodLabel(row.paymentMethod)}
                        {row.paymentTypeName ? <span className="small"> · {row.paymentTypeName}</span> : null}
                        {row.advanceReceiptNumber ? <span className="muted small"> · {row.advanceReceiptNumber}</span> : null}
                        {row.transactionRef ? <span className="muted small"> · {row.transactionRef}</span> : null}
                        {row.changeAmount > 0 ? (
                          <span className="muted small"> · change {money(row.changeAmount)}</span>
                        ) : null}
                        {row.tipAmount > 0 ? <span className="bill-tip"> · tip {money(row.tipAmount)}</span> : null}
                      </span>
                      <span className="bill-history-end">
                        <strong>{money(row.amount)}</strong>
                        {canTakePayment &&
                          row.dayOpen &&
                          row.paymentMethod !== "advance" &&
                          bill.billStatus !== "void" &&
                          (!fixing || fixing.paymentId !== row.id) && (
                            <button
                              type="button"
                              className="button button-ghost button-sm"
                              onClick={() => {
                                setError("");
                                setFixing({
                                  paymentId: row.id,
                                  method: row.paymentMethod === "cash" && !(row.changeAmount > 0) ? "upi" : "cash",
                                  typeId: "",
                                  reference: "",
                                  reason: "",
                                });
                              }}
                              aria-label={`Correct how the ${money(row.amount)} payment was taken`}
                            >
                              Correct
                            </button>
                          )}
                      </span>
                    </li>
                  ))}
                  {bill.refunds.map((row) => (
                    <li key={`r${row.id}`} className="is-refund">
                      <span>
                        <Icon name="undo" size={14} />{" "}
                        {row.creditNoteNumber ? `Refund · ${row.creditNoteNumber}` : "Handed back"} by{" "}
                        {paymentMethodLabel(row.refundMethod)}
                        <span className="muted small"> · {row.reason}</span>
                      </span>
                      <strong>−{money(row.amount)}</strong>
                    </li>
                  ))}
                  {(bill.corrections || []).map((row) => (
                    <li key={`c${row.id}`} className="is-correction">
                      <span className="small">
                        <Icon name="edit" size={14} /> {money(row.amount)} corrected from{" "}
                        {paymentMethodLabel(row.oldMethod)} to {paymentMethodLabel(row.newMethod)}
                        {row.newTypeName ? ` (${row.newTypeName})` : ""}
                        <span className="muted"> · {row.reason} · {row.correctedBy}
                          {row.approvedBy ? `, approved by ${row.approvedBy}` : ""}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {fixForm}
              </div>
            )}

            {bill.creditNotes && bill.creditNotes.length > 0 && (
              <div className="bill-history">
                <h3>Credit notes</h3>
                <ul>
                  {bill.creditNotes.map((note) => (
                    <li key={note.id}>
                      <span>
                        <strong className="mono">{note.number}</strong>{" "}
                        <span className="muted small">
                          {note.kind === "return" ? "dishes returned" : "refund"} · GST {money(note.taxAmount)}
                          {note.pointsReversed ? ` · ${note.pointsReversed} points back` : ""}
                        </span>
                      </span>
                      <span className="bill-history-end">
                        <strong>{money(note.totalAmount)}</strong>
                        <button
                          type="button"
                          className="button button-ghost button-sm"
                          onClick={() => printCreditNote(bill, note, { settings, currency })}
                        >
                          <Icon name="print" size={14} /> Print
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {mode === "bills" && (refundForm || voidForm) && (
              <div className="bill-more">
                {refundForm && (
                  <details className="bill-details">
                    <summary>{settled ? "Refund or return dishes" : "Hand back a payment"}</summary>
                    {refundForm}
                  </details>
                )}
                {voidForm && (
                  <details className="bill-details">
                    <summary>Void this bill</summary>
                    {voidForm}
                  </details>
                )}
              </div>
            )}
          </section>
        </div>

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Close
          </button>
          {whatsAppLink && (
            <a className="button button-secondary" href={whatsAppLink} target="_blank" rel="noreferrer">
              <Icon name="phone" size={16} /> Send on WhatsApp
            </a>
          )}
          {/* One main button at a time: while money is still to be taken,
              "Take ₹…" above is it and printing is secondary. */}
          <button
            type="button"
            className={`button ${unsettled && canPay ? "button-secondary" : ""}`}
            onClick={print}
            disabled={busy}
          >
            <Icon name="print" size={16} /> {bill.printCount > 0 ? "Reprint (duplicate)" : "Print bill"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
