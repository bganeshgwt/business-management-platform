import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import Icon from "@bmp/ui/Icon";
import { dateShort, money, moneyExact } from "@bmp/shared/format";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import StatusBadge from "../../../components/StatusBadge";
import Modal from "../../../components/Modal";
import FormField from "../../../components/FormField";
import { EmptyState, ErrorMessage, Loading } from "../../../components/Feedback";
import useAuth from "../../../hooks/useAuth";
import useBusiness from "../../../hooks/useBusiness";
import { getErrorMessage } from "../../../services/api";
import { getCurrentUser } from "../../../services/auth.service";
import { toast } from "../../../services/toast";
import { GST_STATES } from "../../business/core/pages/invoice";
import { getInvoice, getPlan, makeOrder, saveSelection, sendPayment } from "../services/plan.service";
import { printPlanInvoice } from "../planInvoicePrint";
import { usePlanScope } from "../usePlan";
import {
  METHODS, ORDER_STATUS, PAYMENT_STATUS, methodWords, orderSummary, periodWords, priceText, selectionSummary, standing, stateBadge, yearlySaving,
} from "../planWords";
import "../plan.css";

// Your plan, for an owner: a business's (among its Settings in Business
// Admin) and the signed-in restaurant's (/plan), one page on one service
// (/api/businesses/:id/plan, /api/plan). Where the plan stands; the open order
// to pay, with the UPI QR and the bank details, and "I have paid" with the
// payment's reference; the choice for the next period (plan, month or year,
// add-ons, each with its price before GST), which during given time the
// company arranges; modules and applications added to paid time for the days
// left; and the orders, payments and invoices so far, each invoice printed.

const day = (value) => dateShort(value, { year: true });
const states = Object.entries(GST_STATES).map(([code, name]) => ({ code: String(code).padStart(2, "0"), name })).sort((a, b) => a.name.localeCompare(b.name));
const contactOf = (company) => [company?.phone, company?.email].filter(Boolean).join(", ");

export default function YourPlanPage() {
  const { businessId, reloadContext } = useBusiness();
  const { refreshUser } = useAuth();
  const scope = usePlanScope();
  const [params] = useSearchParams();
  const [view, setView] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  // An order waiting for the business's state (the invoice's place of supply).
  const [asking, setAsking] = useState(null);
  const today = scope?.today;

  useEffect(() => {
    const controller = new AbortController();
    getPlan(businessId, controller.signal)
      .then((data) => {
        setView(data);
        setError("");
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(getErrorMessage(err));
        }
      });
    return () => controller.abort();
  }, [businessId, version]);

  // After an order or a payment: this page, and the frame's banner, read the plan again.
  const refresh = useCallback(() => {
    setVersion((n) => n + 1);
    if (businessId) {
      reloadContext();
    } else {
      getCurrentUser().then(refreshUser).catch(() => {});
    }
  }, [businessId, reloadContext, refreshUser]);

  // Makes an order; with no state on the business yet, asks for it first.
  const order = useCallback(async (body) => {
    try {
      await makeOrder(businessId, body);
    } catch (err) {
      if (err?.response?.data?.data?.reason === "state_required") {
        setAsking(body);
        return false;
      }
      throw err;
    }
    toast.success("Your order is made. Pay it as it shows, then tell us below.");
    refresh();
    return true;
  }, [businessId, refresh]);

  const header = (
    <PageHeader
      icon="card"
      eyebrow={businessId ? undefined : "Settings"}
      title="Your plan"
      description="The plan this business pays for, what it unlocks, paying for the next period, and the GST invoice for each payment."
    />
  );

  if (!view) {
    return (
      <div className="stack">
        {header}
        <ErrorMessage message={error} />
        {!error && <Loading />}
      </div>
    );
  }

  return (
    <div className="stack plan-page">
      {header}
      <ErrorMessage message={error} />
      <StandingCard view={view} today={today} />
      {view.openOrder && (
        <OrderCard key={view.openOrder.id} order={view.openOrder} view={view} businessId={businessId} today={today} onSent={refresh} />
      )}
      {view.selection && (
        <ChoiceCard key={`${view.selection.updatedAt}:${version}`} view={view} businessId={businessId} today={today} wanted={params.get("add")} order={order} />
      )}
      {view.plan?.state === "paid" && <AddNowCard key={`add:${version}`} view={view} today={today} wanted={params.get("add")} order={order} />}
      <HistoryCard view={view} businessId={businessId} />
      <p className="muted small plan-contact">
        Questions about your plan? Ask {view.company?.name}{contactOf(view.company) ? `: ${contactOf(view.company)}` : ""}.
      </p>
      {asking && (
        <StateDialog
          onClose={() => setAsking(null)}
          onChosen={async (stateCode) => {
            const made = await order({ ...asking, stateCode });
            if (made) {
              setAsking(null);
            }
          }}
        />
      )}
    </div>
  );
}

// The dates that go with the plan's state, as [label, date] rows.
function datesOf(plan) {
  if (!plan) return [];
  switch (plan.state) {
    case "trial":
      return [["Trial ends", day(plan.trialEndsOn)], ...(plan.accessEndsOn !== plan.trialEndsOn ? [["Then runs to", plan.accessEndsOn ? day(plan.accessEndsOn) : "No end date"]] : [])];
    case "paid":
      return [["Paid until", day(plan.accessEndsOn)]];
    case "given":
      return [["Given until", plan.accessEndsOn ? day(plan.accessEndsOn) : "No end date"]];
    case "grace":
      return [["Ended on", day(plan.accessEndsOn)], ["Renew by", day(plan.graceEndsOn)]];
    default:
      return plan.accessEndsOn ? [["Ended on", day(plan.accessEndsOn)]] : [];
  }
}

// Where the plan stands: its state, what it unlocks today and its dates.
function StandingCard({ view, today }) {
  const { plan, company, entitled, catalogue } = view;
  const badge = stateBadge(plan, { today }) || (plan?.state === "given" ? { tone: "success", label: "Arranged by us" } : null);
  const names = new Map((catalogue?.addons || []).map((addon) => [addon.code, addon.name]));
  const unlocked = plan?.everything ? null : (entitled || []).map((code) => names.get(code)).filter(Boolean);

  return (
    <SectionCard icon="card" title="Where your plan stands" actions={badge && <StatusBadge tone={badge.tone} label={badge.label} />}>
      <p className="plan-standing">{standing(plan, { today, brand: company?.name })}</p>
      <dl className="plan-facts">
        <dt>Unlocked now</dt>
        <dd>{unlocked === null ? "Every module and application this type of business can use" : unlocked.length ? unlocked.join(", ") : "The everyday screens only"}</dd>
        {datesOf(plan).map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </SectionCard>
  );
}

// The open order: its lines and GST, how to pay it, and "I have paid".
function OrderCard({ order, view, businessId, today, onSent }) {
  const rows = orderSummary(order);
  const pending = order.payments.find((payment) => payment.status === "pending");
  const rejected = order.payments.filter((payment) => payment.status === "rejected");
  const addOn = order.kind === "add_on";

  return (
    <SectionCard
      className="plan-order"
      icon="receipt"
      title={addOn ? "Pay for the add-ons" : "Pay for your plan"}
      description={`Order ${order.id}, for ${day(order.startsOn)} to ${day(order.endsOn)}. Its prices hold until ${day(order.validUntil)}.`}
    >
      <div className="table-wrap">
        <table className="table plan-lines">
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className={row.total ? "is-total" : undefined}>
                <th scope="row">
                  {row.label}
                  {row.detail && <small> · {row.detail}</small>}
                </th>
                <td className="right">{row.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Place of supply: {order.placeOfSupply} ({order.placeOfSupplyCode}). Prices are before GST.</p>
      {pending ? (
        <div className="plan-checking" role="status">
          <Icon name="clock" size={18} />
          <div>
            <strong>Payment being checked</strong>
            <p>
              {moneyExact(pending.amount)} by {methodWords(pending.method)}, reference <span className="mono">{pending.reference}</span>, paid on {day(pending.paidOn)}.
              We confirm it here once it reaches us.
            </p>
          </div>
        </div>
      ) : (
        <>
          <HowToPay order={order} payTo={view.payTo} company={view.company} />
          {rejected.map((payment) => (
            <p key={payment.id} className="alert">
              The payment with reference {payment.reference} could not be confirmed{payment.decisionNote ? `: ${payment.decisionNote}` : ""}. Check it and tell us again.
            </p>
          ))}
          <PaidForm order={order} businessId={businessId} today={today} onSent={onSent} />
        </>
      )}
    </SectionCard>
  );
}

// The company's UPI ID with a QR for the order's exact amount, and its bank account.
function HowToPay({ order, payTo, company }) {
  const [qr, setQr] = useState({ link: null, image: "" });
  const total = moneyExact(order.total);
  const bank = Boolean(payTo?.bankAccountNumber && payTo?.bankIfsc);

  useEffect(() => {
    let alive = true;

    if (payTo?.upiLink) {
      QRCode.toDataURL(payTo.upiLink, { width: 240, margin: 1, errorCorrectionLevel: "M" })
        .then((image) => alive && setQr({ link: payTo.upiLink, image }))
        .catch(() => alive && setQr({ link: payTo.upiLink, image: "" }));
    }

    return () => {
      alive = false;
    };
  }, [payTo?.upiLink]);

  if (!payTo?.upiId && !bank) {
    return (
      <p className="alert alert-notice">
        How to pay is not set up yet. Ask {company?.name}{contactOf(company) ? ` (${contactOf(company)})` : ""}.
      </p>
    );
  }

  return (
    <div className="plan-pay">
      {payTo.upiId && (
        <div>
          <h3>Pay by UPI</h3>
          {qr.link === payTo.upiLink && qr.image ? (
            <img className="plan-qr" src={qr.image} width={180} height={180} alt={`UPI QR code to pay ${total}`} />
          ) : (
            <span className="skeleton plan-qr" />
          )}
          <p>Scan it with any UPI app: the amount, {total}, and the order number fill in by themselves.</p>
          <dl className="plan-facts">
            <dt>UPI ID</dt>
            <dd className="mono">{payTo.upiId}</dd>
            <dt>Paid to</dt>
            <dd>{payTo.upiPayee}</dd>
          </dl>
        </div>
      )}
      {bank && (
        <div>
          <h3>Pay by bank transfer</h3>
          <dl className="plan-facts">
            {payTo.bankName && (
              <>
                <dt>Bank</dt>
                <dd>{payTo.bankName}</dd>
              </>
            )}
            {payTo.bankAccountName && (
              <>
                <dt>Account name</dt>
                <dd>{payTo.bankAccountName}</dd>
              </>
            )}
            <dt>Account number</dt>
            <dd className="mono">{payTo.bankAccountNumber}</dd>
            <dt>IFSC</dt>
            <dd className="mono">{payTo.bankIfsc}</dd>
          </dl>
          <p>Write “Order {order.id}” in the transfer's remarks.</p>
        </div>
      )}
      {payTo.note && <p className="muted small">{payTo.note}</p>}
    </div>
  );
}

// "I have paid": how, the payment's reference and the day. The company checks it.
function PaidForm({ order, businessId, today, onSent }) {
  const [form, setForm] = useState({ method: "upi", reference: "", paidOn: today || "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (name) => (event) => setForm((current) => ({ ...current, [name]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      await sendPayment(businessId, order.id, form);
      toast.success("Thank you. We check the payment and confirm it here.");
      onSent();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="plan-paid-form" onSubmit={submit}>
      <h3>I have paid</h3>
      <p className="muted small">
        Once you have paid {moneyExact(order.total)}, say how and give the payment's reference: we check it with the bank and confirm it here.
      </p>
      <ErrorMessage message={error} />
      <fieldset className="plan-fieldset" disabled={busy}>
        <div className="form-grid">
          <FormField label="Paid by">
            <select value={form.method} onChange={set("method")}>
              {METHODS.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Payment reference" hint="The UPI transaction ID or UTR, the bank transfer's reference, or the cheque number.">
            <input required maxLength={100} value={form.reference} onChange={set("reference")} autoComplete="off" />
          </FormField>
          <FormField label="Date paid">
            <input type="date" required max={today || undefined} value={form.paidOn} onChange={set("paidOn")} />
          </FormField>
        </div>
        <div className="form-actions">
          <button type="submit" className="button">
            {busy ? "Sending…" : "I have paid"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

// The words at the top of the choice, by the plan's state.
function choiceWords(plan, company) {
  const contact = contactOf(company);
  switch (plan?.state) {
    case "trial":
      return { title: "Choose your plan", description: "What you pay for once the trial ends. Changing it is free until then.", action: "Pay now" };
    case "paid":
      return {
        title: "Your next period",
        description: "What your renewal is made of. A change here starts with the next period; to use a module or application now, add it to this period below.",
        action: "Renew now",
      };
    case "given":
      return {
        title: "Your plan",
        description: `Your access is arranged by ${company?.name}. Contact us to change it${contact ? ` (${contact})` : ""}.`,
        action: null,
      };
    case "grace":
      return { title: "Renew your plan", description: "The new period starts the day after your plan ended, so no day is lost.", action: "Renew now" };
    default:
      return { title: "Renew your plan", description: "The new period starts today.", action: "Renew now" };
  }
}

// The choice for the next period: the plan, month or year, and add-ons, with
// the price before GST. Saved as it is paid (or on its own); during given time
// it is the company's.
function ChoiceCard({ view, businessId, today, wanted, order }) {
  const { plan, selection, catalogue, gstRate, company } = view;
  const { context } = useBusiness();
  const { user } = useAuth();
  const plans = catalogue?.plans || [];
  const addons = catalogue?.addons || [];
  const words = choiceWords(plan, company);
  const readOnly = !words.action;
  const [draft, setDraft] = useState(() => {
    const chosen = selection.addons.map((addon) => addon.code);
    const planNow = plans.find((item) => item.code === selection.planCode) || plans[0];
    const included = new Set((planNow?.modules || []).map((module) => module.code));
    // Add to plan, from Business tools or Features: offered here outside paid time.
    const add = plan?.state !== "paid" && wanted && addons.some((addon) => addon.code === wanted) && !included.has(wanted) && !chosen.includes(wanted);
    return { planCode: planNow?.code || selection.planCode, billingPeriod: selection.billingPeriod || "year", addons: add ? [...chosen, wanted] : chosen };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saved = { planCode: selection.planCode, billingPeriod: selection.billingPeriod, addons: selection.addons.map((addon) => addon.code) };
  const dirty = JSON.stringify({ ...draft, addons: [...draft.addons].sort() }) !== JSON.stringify({ ...saved, addons: [...saved.addons].sort() });
  const chosenPlan = plans.find((item) => item.code === draft.planCode);
  const included = useMemo(() => new Set((chosenPlan?.modules || []).map((module) => module.code)), [chosenPlan]);
  const summary = selectionSummary({
    catalogue, planCode: draft.planCode, billingPeriod: draft.billingPeriod, addons: draft.addons, gstRate,
    trialEndsOn: plan?.state === "trial" ? plan.trialEndsOn : null, today,
  });
  const pending = Boolean(view.openOrder?.payments?.some((payment) => payment.status === "pending"));
  // What is switched on now (a business's modules; a restaurant's features), to mark what the choice leaves out.
  const inUse = new Set(context ? context.modules || [] : user?.features || []);
  const priceOf = (item) => (draft.billingPeriod === "month" ? item.monthly : item.yearly);
  const saving = chosenPlan ? yearlySaving(chosenPlan) : null;

  const toggle = (code) => setDraft((current) => ({
    ...current, addons: current.addons.includes(code) ? current.addons.filter((item) => item !== code) : [...current.addons, code],
  }));
  const body = () => ({ ...draft, addons: draft.addons.filter((code) => !included.has(code)) });

  const save = async () => {
    setBusy(true);
    setError("");

    try {
      await saveSelection(businessId, body());
      toast.success("Your choice is saved: it is what your next order is made of.");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const pay = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      if (dirty) {
        await saveSelection(businessId, body());
      }
      await order({ kind: "subscription" });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard as="form" className="plan-choice" icon="layers" title={words.title} description={words.description} onSubmit={pay}>
      <ErrorMessage message={error} />
      <fieldset className="plan-fieldset" disabled={readOnly || busy}>
        <fieldset className="plan-group">
          <legend>Plan</legend>
          <div className="plan-options">
            {plans.map((item) => (
              <label key={item.code} className={`plan-option ${draft.planCode === item.code ? "is-chosen" : ""}`}>
                <input
                  type="radio"
                  name="plan"
                  value={item.code}
                  checked={draft.planCode === item.code}
                  onChange={() => setDraft((current) => ({ ...current, planCode: item.code }))}
                />
                <span className="plan-option-text">
                  <strong>{item.name}</strong>
                  <span className="plan-price">{priceOf(item) === null || priceOf(item) === undefined ? "Price not set yet" : `${priceText(priceOf(item), draft.billingPeriod)} + GST`}</span>
                  {item.description && <small>{item.description}</small>}
                  {item.modules?.length > 0 && <small>Includes {item.modules.map((module) => module.name).join(", ")}</small>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="plan-group">
          <legend>Billed</legend>
          <div className="plan-options">
            {[["month", "Monthly"], ["year", "Yearly"]].map(([period, label]) => (
              <label key={period} className={`plan-option ${draft.billingPeriod === period ? "is-chosen" : ""}`}>
                <input
                  type="radio"
                  name="billing"
                  value={period}
                  checked={draft.billingPeriod === period}
                  onChange={() => setDraft((current) => ({ ...current, billingPeriod: period }))}
                />
                <span className="plan-option-text">
                  <strong>{label}</strong>
                  {chosenPlan && <small>{priceText(period === "month" ? chosenPlan.monthly : chosenPlan.yearly, period)}{period === "year" && saving ? `: ${money(saving)} less than paying monthly` : ""}</small>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {[["application", "Applications"], ["module", "Modules"]].map(([kind, title]) => {
          const list = addons.filter((addon) => addon.soldAs === kind && !included.has(addon.code));
          return list.length > 0 && (
            <fieldset key={kind} className="plan-group">
              <legend>{title} to add</legend>
              <div className="plan-addon-list">
                {list.map((addon) => {
                  const checked = draft.addons.includes(addon.code);
                  const price = priceOf(addon);
                  const blocked = !addon.available || price === null || price === undefined;
                  const needs = (addon.requires || []).filter((code) => !included.has(code) && !draft.addons.includes(code));
                  return (
                    <label key={addon.code} className={`plan-addon ${checked ? "is-chosen" : ""} ${blocked && !checked ? "is-blocked" : ""}`}>
                      <input type="checkbox" checked={checked} disabled={blocked && !checked} onChange={() => toggle(addon.code)} />
                      <span className="plan-addon-text">
                        <strong>{addon.name}</strong>
                        <span className="plan-price">{addon.available ? priceText(price, draft.billingPeriod) : "Ask us to add it"}</span>
                        {addon.description && <small>{addon.description}</small>}
                        {checked && needs.length > 0 && <small>Needs {needs.map((code) => addons.find((item) => item.code === code)?.name || code).join(", ")} too.</small>}
                        {!checked && inUse.has(addon.code) && <small>In use now: leave it out and it switches off when this period ends.</small>}
                      </span>
                      {addon.recommended && !checked && <StatusBadge tone="info" label="Recommended" />}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}

        {!readOnly && (
          <div className="plan-summary-row">
            <p className="plan-summary">{summary.text}</p>
            <div className="form-actions">
              {dirty && (
                <button type="button" className="button button-secondary" onClick={save}>
                  Save choice
                </button>
              )}
              <button type="submit" className="button" disabled={summary.missing.length > 0 || pending}>
                {busy ? "Working…" : words.action}
              </button>
            </div>
          </div>
        )}
        {!readOnly && pending && <p className="muted small">A payment for the open order is being checked: a new order waits until it is confirmed or not.</p>}
      </fieldset>
    </SectionCard>
  );
}

// Paid time: modules and applications for the rest of the period, each at its
// price for the period times the days left over the days in the period.
function AddNowCard({ view, today, wanted, order }) {
  const { catalogue, entitled, orders, selection } = view;
  const current = (orders || []).find((item) => item.kind === "subscription" && item.status === "paid" && item.startsOn <= today && item.endsOn >= today);
  const billingPeriod = current?.billingPeriod || selection?.billingPeriod || "year";
  const ends = current?.endsOn || view.plan.accessEndsOn;
  const addable = (catalogue?.addons || []).filter((addon) => !(entitled || []).includes(addon.code) && addon.available);
  const [chosen, setChosen] = useState(() => (wanted && addable.some((addon) => addon.code === wanted) ? [wanted] : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!addable.length) {
    return null;
  }

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      await order({ kind: "add_on", modules: chosen });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      as="form"
      className="plan-add-now"
      icon="plus"
      title="Add to this period"
      description={`Use a module or application from today to ${day(ends)}: each costs its price for ${periodWords(billingPeriod)} for the days left.`}
      onSubmit={submit}
    >
      <ErrorMessage message={error} />
      <fieldset className="plan-fieldset" disabled={busy}>
        <div className="plan-addon-list">
          {addable.map((addon) => {
            const price = billingPeriod === "month" ? addon.monthly : addon.yearly;
            const checked = chosen.includes(addon.code);
            return (
              <label key={addon.code} className={`plan-addon ${checked ? "is-chosen" : ""}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={price === null || price === undefined}
                  onChange={() => setChosen((list) => (list.includes(addon.code) ? list.filter((code) => code !== addon.code) : [...list, addon.code]))}
                />
                <span className="plan-addon-text">
                  <strong>{addon.name}</strong>
                  <span className="plan-price">{priceText(price, billingPeriod)}, for the days left</span>
                  {addon.description && <small>{addon.description}</small>}
                </span>
              </label>
            );
          })}
        </div>
        <div className="form-actions">
          <button type="submit" className="button" disabled={!chosen.length}>
            {busy ? "Working…" : "Pay for the rest of this period"}
          </button>
        </div>
      </fieldset>
    </SectionCard>
  );
}

// The orders, payments and invoices so far; each invoice prints.
function HistoryCard({ view, businessId }) {
  const [printing, setPrinting] = useState(null);
  const [error, setError] = useState("");
  const invoices = view.invoices || [];
  const payments = view.payments || [];
  const orders = view.orders || [];

  const print = async (invoice) => {
    setPrinting(invoice.id);
    setError("");

    try {
      printPlanInvoice(await getInvoice(businessId, invoice.id));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setPrinting(null);
    }
  };

  return (
    <SectionCard icon="history" title="Orders, payments and invoices" description="Each confirmed payment has the company's GST invoice: print it, or save it as a PDF from the print window.">
      <ErrorMessage message={error} />
      {orders.length === 0 ? (
        <EmptyState icon="receipt" message="No orders yet." hint="An order is made when you pay for your plan; its invoice is here once the payment is confirmed." />
      ) : (
        <div className="plan-history">
          <div>
            <h3>Invoices</h3>
            {invoices.length === 0 ? (
              <p className="muted small">None yet: an invoice is issued once a payment is confirmed.</p>
            ) : (
              <div className="table-wrap">
                <table className="table plan-invoices">
                  <thead>
                    <tr><th>Invoice</th><th>Date</th><th className="right">Total</th><th /><th /></tr>
                  </thead>
                  <tbody>
                    {invoices.map((invoice) => (
                      <tr key={invoice.id}>
                        <td className="mono">{invoice.number}</td>
                        <td>{day(invoice.issuedOn)}</td>
                        <td className="right">{moneyExact(invoice.total)}</td>
                        <td>{invoice.sample && <StatusBadge tone="warning" label="SAMPLE" />}</td>
                        <td className="right">
                          <button type="button" className="button button-secondary button-sm" disabled={printing === invoice.id} onClick={() => print(invoice)}
                            aria-label={`Print invoice ${invoice.number}`}>
                            <Icon name="print" size={15} /> Print
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {payments.length > 0 && (
            <div>
              <h3>Payments</h3>
              <div className="table-wrap">
                <table className="table plan-payments">
                  <thead>
                    <tr><th>Paid on</th><th>By</th><th>Reference</th><th className="right">Amount</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {payments.map((payment) => (
                      <tr key={payment.id}>
                        <td>{day(payment.paidOn)}</td>
                        <td>{methodWords(payment.method)}</td>
                        <td className="mono">{payment.reference}</td>
                        <td className="right">{moneyExact(payment.amount)}</td>
                        <td>
                          <StatusBadge tone={PAYMENT_STATUS[payment.status]?.tone} label={PAYMENT_STATUS[payment.status]?.label || payment.status} />
                          {payment.decisionNote && <small className="muted"> {payment.decisionNote}</small>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <div>
            <h3>Orders</h3>
            <div className="table-wrap">
              <table className="table plan-orders">
                <thead>
                  <tr><th>Order</th><th>For</th><th>Period</th><th className="right">Total</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {orders.map((item) => (
                    <tr key={item.id}>
                      <td className="mono">{item.id}</td>
                      <td>{item.kind === "add_on" ? "Add-ons" : `Plan, ${periodWords(item.billingPeriod)}`}</td>
                      <td>{day(item.startsOn)} to {day(item.endsOn)}</td>
                      <td className="right">{moneyExact(item.total)}</td>
                      <td><StatusBadge tone={ORDER_STATUS[item.status]?.tone} label={ORDER_STATUS[item.status]?.label || item.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// The business's state, asked for the first order when it has none: GST's
// place of supply, printed on the invoice.
function StateDialog({ onClose, onChosen }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      await onChosen(code);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Your business's state" description="GST needs the state this business works from: it is the place of supply on your invoice." onClose={onClose} width={460} dismissible={!busy}>
      <form className="stack" onSubmit={submit}>
        <ErrorMessage message={error} />
        <FormField label="State">
          <select required value={code} onChange={(event) => setCode(event.target.value)}>
            <option value="">Choose the state…</option>
            {states.map((state) => (
              <option key={state.code} value={state.code}>
                {state.name} ({state.code})
              </option>
            ))}
          </select>
        </FormField>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy || !code}>
            {busy ? "Working…" : "Make the order"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
