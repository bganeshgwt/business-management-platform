import { Fragment, useEffect, useMemo, useState } from "react";
import SearchPicker from "../../../../components/SearchPicker";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import useAuth from "../../../../hooks/useAuth";
import MemberApproval from "./MemberApproval";
import { ADDON_KINDS, approvalBody, dayWords, emptyApproval, splitInstalments, termWords, wordOf, VISIT_PERIODS } from "./memberships";
import { NewCustomerConsents } from "../../../personal-data/components/ConsentChoices";
import { consentChanges } from "../../../personal-data/personalData";

// Selling a membership, renewing one or upgrading one to another plan. The
// bill is worked out by the server as it will be posted (the plan's price as
// the catalogue has it, the member's own prices, offers, the discount, GST)
// and shown as it changes; what is paid now is taken with it, the rest left
// on the member's dues or split into instalments that add up to the bill. A
// renewal starts the day after the membership it renews ends; an upgrade
// starts today and its old membership's unused part pays first (a cheaper
// plan: what is left over stays with the member, or goes back with a
// manager's approval). A sale names who sold it and the trainer it counts
// for, may carry add-ons (a locker with its number), gives a shared plan's
// seats, and closes the enquiry it came from.
//   mode: sell | renew | upgrade; member: the member (none: choose or type one);
//   membership: the one renewed or upgraded; lead: the enquiry sold from.

const PAY_KINDS = ["cash", "upi", "card", "bank"];
const PAN_ABOVE = 200000;

// A list this person may read, or none (the seller and trainer choices are optional).
function useList(biz, path, allowed) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!allowed) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, path, { limit: 100 }, controller.signal).then((page) => setRows(Array.isArray(page) ? page : page.items || [])).catch(() => setRows([]));
    return () => controller.abort();
  }, [biz.id, path, allowed]);
  return rows;
}

export default function MembershipDialog({ mode = "sell", member, membership, lead, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const staff = useList(biz, "members", biz.can("access.view"));
  const trainers = useList(biz, "resources", biz.has("appointments") && biz.can("appointments.view"));
  const [approval, setApproval] = useState(emptyApproval);
  const [requestKey] = useState(newKey);
  const today = businessToday(biz.business.timezone);
  const { options } = useOptions(["member-plans/plans?active=true"]);
  const plans = useMemo(() => (options?.["member-plans/plans?active=true"] || []), [options]);
  const [chosen, setChosen] = useState(member || (lead?.contact_id ? { id: lead.contact_id, name: lead.name } : null));
  const [form, setForm] = useState(() => ({
    soldBy: "", trainerId: "", addons: [], seats: [], difference: "credit", refundMethod: "cash", refundOn: "",
    planId: mode === "renew" && membership ? String(membership.plan_id) : "", newMember: Boolean(lead && !lead.contact_id), name: lead?.name || "", phone: lead?.phone || "", startOn: today, joining: null,
    locationId: String(biz.currentLocationId || biz.member.location_id || biz.locations[0]?.id || ""), amount: "", method: "cash", reference: "",
    discountAmount: "", discountReason: "", split: false, parts: "4", firstDue: today, instalments: [], pan: "", declaration: false, notes: "",
  }));
  const [figures, setPreview] = useState(null);
  const [problem, setProblem] = useState("");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const plan = plans.find((p) => String(p.id) === String(form.planId));
  const contactId = form.newMember ? null : chosen?.id || null;
  const discount = form.discountAmount ? { discount: { amount: form.discountAmount, reason: form.discountReason } } : {};
  const addons = form.addons.filter((a) => a.item).map((a) => ({ skuId: a.item.id, kind: a.kind, ...(a.kind === "locker" ? { lockerNo: a.lockerNo } : {}) }));
  // The figures as the server works them out, each time what decides them changes.
  const asked = JSON.stringify({ planId: form.planId, contactId, startOn: form.startOn, joining: form.joining, discount, locationId: form.locationId, addons });
  // The figures shown are those worked out for what is asked now.
  const preview = figures && figures.asked === asked && form.planId ? figures : null;
  useEffect(() => {
    if (!form.planId || !form.locationId) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const body = mode === "upgrade" ? { planId: form.planId, locationId: form.locationId, ...discount }
        : { planId: form.planId, locationId: form.locationId, ...(contactId ? { contactId } : {}), ...(mode === "renew" ? { renewalOf: membership.id } : { startOn: form.startOn }),
          ...(form.joining === null ? {} : { joiningFee: form.joining }), ...discount, ...(addons.length ? { addons } : {}) };
      const path = mode === "upgrade" ? `member-plans/memberships/${membership.id}/upgrade/preview` : "member-plans/memberships/preview";
      businessWrite(biz.id, path, body).then((p) => { if (!controller.signal.aborted) { setPreview({ ...p, asked }); setProblem(""); } })
        .catch((err) => { if (!controller.signal.aborted) { setPreview(null); setProblem(getErrorMessage(err)); } });
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = preview ? Number(mode === "upgrade" ? preview.newTotal : preview.total) : 0;
  const shared = Number(plan?.seats || 1) > 1 && mode !== "upgrade";
  const refunding = mode === "upgrade" && preview?.cheaper && form.difference === "refund";
  const setList = (name, n, change) => setForm((f) => ({ ...f, [name]: f[name].map((x, k) => (k === n ? { ...x, ...change } : x)) }));
  const searchServices = (q, { signal }) => businessRead(biz.id, "catalog", { kind: "service", active: "true", q, limit: 15 }, signal).then((page) => page.items);
  const searchMembers = (q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items);
  const due = preview ? Number(mode === "upgrade" ? preview.due : preview.total) : 0;
  const joiningShown = mode === "sell" && plan?.joining_sku_id;
  const joiningOn = form.joining === null ? Boolean(preview?.joiningFee) : form.joining;
  const instalments = form.split ? (form.instalments.length ? form.instalments : splitInstalments(total, form.parts, form.firstDue)) : [];
  const instalmentSum = instalments.reduce((s, i) => s + Math.round(Number(i.amount || 0) * 100), 0);
  const big = total > PAN_ABOVE;
  const canPay = biz.can("sales.edit");
  const paying = canPay && form.amount !== "" && Number(form.amount) > 0;
  const submit = () => {
    if (mode === "sell" && !form.newMember && !chosen && !lead) throw new Error("Choose the member, or tick a new member and type their name");
    if (shared && form.seats.length && !contactId) throw new Error("Choose the member who holds the shared plan from the members first, then give its seats");
    if (!preview) throw new Error(problem || "The bill is still being worked out");
    if (form.split && instalmentSum !== Math.round(total * 100)) throw new Error(`The instalments add up to ${biz.exact(instalmentSum / 100)}, not the bill's ${biz.exact(total)}`);
    const payments = paying ? [{ amount: Math.abs(Number(form.amount) - due) < 0.005 ? "full" : form.amount, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined }] : undefined;
    const common = { requestKey, locationId: form.locationId, planId: form.planId, ...discount, ...(payments ? { payments } : {}),
      ...(form.split ? { instalments: instalments.map((i) => ({ dueOn: i.dueOn, amount: i.amount })) } : {}),
      ...(big ? { buyer: { pan: form.pan.trim() || undefined, panDeclaration: form.declaration } } : {}), notes: form.notes.trim() || undefined };
    if (mode === "upgrade") {
      return businessWrite(biz.id, `member-plans/memberships/${membership.id}/upgrade`, { ...common, ...(preview.cheaper ? { difference: form.difference } : {}),
        ...(refunding ? { refund: methods.body(form.refundMethod, PAY_KINDS), ...(form.refundOn ? { refundOn: form.refundOn } : {}), approval: approvalBody(approval, user?.id) } : {}) });
    }
    const seats = shared && form.seats.length ? [{ contactId: contactId || undefined, ...(contactId ? {} : { name: form.name, phone: form.phone || undefined }) },
      ...form.seats.filter((s) => s.member || s.name).map((s) => (s.member ? { contactId: s.member.id } : { name: s.name, phone: s.phone || undefined }))] : undefined;
    return businessWrite(biz.id, "member-plans/memberships", { ...common,
      ...(form.newMember ? { member: { name: form.name, phone: form.phone || undefined, consents: consentChanges(form.consents, []) || undefined } } : chosen ? { contactId: chosen.id } : {}),
      ...(mode === "renew" ? { renewalOf: membership.id } : { startOn: form.startOn }), ...(joiningShown ? { joiningFee: joiningOn } : {}),
      ...(addons.length ? { addons } : {}), ...(seats && contactId ? { seatMembers: seats } : {}), ...(form.soldBy ? { soldBy: form.soldBy } : {}),
      ...(form.trainerId ? { trainerId: form.trainerId } : {}), ...(lead ? { leadId: lead.id } : {}) });
  };
  const titles = { sell: "Sell a membership", renew: `Renew ${membership?.membership_no || ""}`, upgrade: `Change the plan of ${membership?.membership_no || ""}` };
  const choices = plans.filter((p) => mode !== "upgrade" || String(p.id) !== String(membership?.plan_id));
  return (
    <FormDialog title={titles[mode]} icon="user-plus" width={760} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={mode === "upgrade" ? "Change the plan and post the bill" : "Post the bill"}
      description={mode === "renew" ? "The renewal starts the day after this membership ends, or today if it ended more than its grace days ago."
        : mode === "upgrade" ? "The new plan starts today. The part of this membership not used comes back as a credit note on its bill, and pays the new bill first."
          : lead ? `Sold from ${lead.name}'s enquiry, which closes as the member they became.` : "The bill is posted with the membership; what is not paid now stays on the member's dues."}>
      {mode === "sell" && !member && !lead?.contact_id && (
        <>
          {form.newMember ? (
            <>
              <Field label="Member's name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
              <Field label="Phone"><input inputMode="tel" maxLength={30} value={form.phone} onChange={set("phone")} /></Field>
              <NewCustomerConsents value={form.consents} onChange={(consents) => setForm((f) => ({ ...f, consents }))} />
            </>
          ) : (
            <div className="field-wide">
              <SearchPicker label="Member" placeholder="Name, phone or member code" value={chosen} onChange={setChosen} minChars={2}
                search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
                getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
            </div>
          )}
          {biz.can("contacts.create") && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.newMember} onChange={set("newMember")} /> A new member</label>}
        </>
      )}
      {(member || membership) && <Field label="Member"><input readOnly value={member?.name || membership?.member_name || ""} /></Field>}
      <Field label={mode === "upgrade" ? "New plan" : "Plan"}>
        <select required value={form.planId} onChange={(e) => setForm((f) => ({ ...f, planId: e.target.value, joining: null, instalments: [] }))}>
          <option value="">Choose the plan…</option>
          {choices.map((p) => <option key={p.id} value={p.id}>{p.name} · {termWords(p)} · {biz.exact(p.price)}{Number(p.tax_rate) ? ` + GST ${Number(p.tax_rate)}%` : ""}</option>)}
        </select>
      </Field>
      {mode === "sell" && <Field label="Starts on"><input type="date" required min={today} value={form.startOn} onChange={set("startOn")} /></Field>}
      {mode !== "upgrade" && staff.length > 0 && (
        <Field label="Sold by" hint="Their commission on plans sold."><select value={form.soldBy} onChange={set("soldBy")}>
          <option value="">Me</option>{staff.filter((s) => s.active && String(s.id) !== String(user?.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select></Field>
      )}
      {mode !== "upgrade" && trainers.length > 0 && (
        <Field label="Trainer (optional)" hint="The trainer the sale counts for."><select value={form.trainerId} onChange={set("trainerId")}>
          <option value="">None</option>{trainers.filter((r) => r.active !== false).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select></Field>
      )}
      {shared && (
        <fieldset className="field-wide mem-seats">
          <legend>Seats: {plan.seats} (the member holding it takes the first)</legend>
          {form.seats.map((s, n) => (
            <div key={n} className="mem-instalment">
              <span className="muted">{n + 2}</span>
              {s.typed ? (
                <>
                  <input aria-label={`Seat ${n + 2}: name`} maxLength={150} value={s.name || ""} onChange={(e) => setList("seats", n, { name: e.target.value })} placeholder="Name" />
                  <input aria-label={`Seat ${n + 2}: phone`} inputMode="tel" maxLength={30} value={s.phone || ""} onChange={(e) => setList("seats", n, { phone: e.target.value })} placeholder="Phone" />
                </>
              ) : (
                <SearchPicker label={`Seat ${n + 2}`} placeholder="Name or phone" value={s.member || null} onChange={(m) => setList("seats", n, { member: m })} minChars={2}
                  search={searchMembers} getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
              )}
            </div>
          ))}
          {form.seats.length < Number(plan.seats) - 1 && (
            <span className="bz-row-actions">
              <button type="button" className="chip-button" onClick={() => setForm((f) => ({ ...f, seats: [...f.seats, { typed: false }] }))}>A member for a seat</button>
              {biz.can("contacts.create") && <button type="button" className="chip-button" onClick={() => setForm((f) => ({ ...f, seats: [...f.seats, { typed: true }] }))}>A new member for a seat</button>}
            </span>
          )}
        </fieldset>
      )}
      {mode === "sell" && (
        <fieldset className="field-wide mem-addons">
          <legend>Add-ons (optional)</legend>
          {form.addons.map((a, n) => (
            <div key={n} className="mem-instalment">
              <select aria-label={`Add-on ${n + 1}: kind`} value={a.kind} onChange={(e) => setList("addons", n, { kind: e.target.value })}>
                {ADDON_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
              <SearchPicker label={`Add-on ${n + 1}: item`} placeholder="A service such as Locker" value={a.item || null} onChange={(item) => setList("addons", n, { item })} minChars={1}
                search={searchServices} getLabel={(s) => s.label} getDescription={(s) => (s.price !== undefined ? biz.exact(s.price) : "")} />
              {a.kind === "locker" && <input aria-label={`Add-on ${n + 1}: locker number`} required maxLength={20} className="mono" value={a.lockerNo || ""}
                onChange={(e) => setList("addons", n, { lockerNo: e.target.value.toUpperCase() })} placeholder="Locker no." />}
            </div>
          ))}
          <button type="button" className="chip-button" onClick={() => setForm((f) => ({ ...f, addons: [...f.addons, { kind: "locker" }] }))}>Add an add-on</button>
          <small className="muted">An add-on ends with the membership.</small>
        </fieldset>
      )}
      {biz.locations.length > 1 && (
        <Field label="Sold at"><select value={form.locationId} onChange={set("locationId")}>{biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      )}
      {joiningShown && (
        <label className="checkbox bz-check field-wide"><input type="checkbox" checked={joiningOn} onChange={(e) => setForm((f) => ({ ...f, joining: e.target.checked }))} />
          {" "}Bill the joining fee ({plan.joining_label}{plan.joining_price ? `, ${biz.exact(plan.joining_price)}` : ""})</label>
      )}
      {problem && <p className="field-wide mem-note mem-note-danger" role="alert">{problem}</p>}
      {preview && (
        <dl className="field-wide fe-facts mem-bill">
          <dt>Runs</dt><dd>{preview.endOn ? `${dayWords(preview.startOn)} to ${dayWords(preview.endOn)}` : `from ${dayWords(preview.startOn)}`}{preview.sessions ? ` · ${preview.sessions} sessions` : ""}</dd>
          {mode === "upgrade" && (
            <>
              <dt>Not used of {membership.membership_no}</dt><dd>{preview.left} of {preview.whole} {preview.by}: {biz.exact(preview.credit)} back on its bill</dd>
              <dt>The new bill</dt><dd>{biz.exact(preview.newTotal)} ({biz.exact(preview.newSubtotal)} before GST, GST {biz.exact(preview.newTax)})</dd>
              <dt>Credit taken off</dt><dd>{biz.exact(preview.creditApplied)}</dd>
              <dt>To pay</dt><dd><strong>{biz.exact(preview.due)}</strong></dd>
              {preview.cheaper && <><dt>Left over</dt><dd><strong>{biz.exact(preview.leftOver)}</strong> of the credit, after the new bill</dd></>}
            </>
          )}
          {mode !== "upgrade" && (
            <>
              <dt>The bill</dt><dd><strong>{biz.exact(preview.total)}</strong> ({biz.exact(preview.subtotal)} before GST, GST {biz.exact(preview.tax)}{Number(preview.roundOff) ? `, round-off ${biz.exact(preview.roundOff)}` : ""})</dd>
              {(preview.lines || []).map((l, i) => <Fragment key={i}><dt className="muted">{l.label}</dt><dd className="muted">{biz.exact(Number(l.net) + Number(l.tax))} (GST {Number(l.taxRate)}%)</dd></Fragment>)}
              {preview.terms && <TermsDisclosed biz={biz} terms={preview.terms} />}
            </>
          )}
        </dl>
      )}
      {mode === "upgrade" && preview?.cheaper && (
        <>
          <Field label="What is left over" wide><select value={form.difference} onChange={set("difference")}>
            <option value="credit">Stays with the member as credit (the credit note)</option>
            {biz.can("member_plans.refund") && <option value="refund">Goes back to the member (a manager approves)</option>}
          </select></Field>
          {refunding && (
            <>
              <Field label="Refunded by"><select value={methods.resolve(form.refundMethod, PAY_KINDS)} onChange={set("refundMethod")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
              <Field label="Refund on" hint="Empty: today. A later day puts it on the bell until it is paid."><input type="date" min={today} value={form.refundOn} onChange={set("refundOn")} /></Field>
              <MemberApproval title="A manager approves the money given back" value={approval} onChange={setApproval} />
            </>
          )}
        </>
      )}
      {biz.can("sales.discount") && mode !== "renew" && (
        <>
          <Field label="Discount (optional)"><input type="number" min="0" step="0.01" value={form.discountAmount} onChange={set("discountAmount")} /></Field>
          {form.discountAmount && <Field label="Why the discount"><input required maxLength={120} value={form.discountReason} onChange={set("discountReason")} placeholder="e.g. Couple plan" /></Field>}
        </>
      )}
      {canPay && (
        <>
          <Field label="Paid now" hint={preview ? `Up to ${biz.exact(due)}; empty or 0 leaves it on the member's dues.` : undefined}>
            <input type="number" min="0" step="0.01" value={form.amount} onChange={set("amount")} placeholder={preview ? due.toFixed(2) : ""} />
          </Field>
          {paying && <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>}
          {paying && <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>}
        </>
      )}
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.split} onChange={(e) => setForm((f) => ({ ...f, split: e.target.checked, instalments: [] }))} /> The fee in instalments</label>
      {form.split && (
        <>
          <Field label="Instalments"><input type="number" min="2" max="36" value={form.parts} onChange={(e) => setForm((f) => ({ ...f, parts: e.target.value, instalments: [] }))} /></Field>
          <Field label="First one falls due"><input type="date" min={today} value={form.firstDue} onChange={(e) => setForm((f) => ({ ...f, firstDue: e.target.value, instalments: [] }))} /></Field>
          <div className="field-wide mem-instalments">
            {instalments.map((i, n) => (
              <div key={n} className="mem-instalment">
                <span className="muted">{n + 1}</span>
                <input type="date" aria-label={`Instalment ${n + 1}: due on`} value={i.dueOn}
                  onChange={(e) => setForm((f) => ({ ...f, instalments: instalments.map((x, k) => (k === n ? { ...x, dueOn: e.target.value } : x)) }))} />
                <input type="number" min="0.01" step="0.01" aria-label={`Instalment ${n + 1}: amount`} value={i.amount}
                  onChange={(e) => setForm((f) => ({ ...f, instalments: instalments.map((x, k) => (k === n ? { ...x, amount: e.target.value } : x)) }))} />
              </div>
            ))}
            <small className={instalmentSum === Math.round(total * 100) ? "muted" : "bz-minus"}>Adds up to {biz.exact(instalmentSum / 100)} of the bill's {biz.exact(total)}.</small>
          </div>
        </>
      )}
      {big && (
        <>
          <Field label="Buyer's PAN" hint="A bill over ₹2,00,000 records it, unless it is saved with the member."><input maxLength={10} className="mono" value={form.pan} onChange={set("pan")} /></Field>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.declaration} onChange={set("declaration")} /> The buyer has no PAN and signed a declaration (Form 97)</label>
        </>
      )}
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}
// The plan's terms told before the sale: its visits, hours and seats, its fees and the late fee's rule.
function TermsDisclosed({ biz, terms: t }) {
  const lines = [
    t.visitLimit ? `${t.visitLimit} visit${Number(t.visitLimit) === 1 ? "" : "s"} ${wordOf(VISIT_PERIODS, t.visitPeriod)}` : null,
    t.hours ? `Lets the member in from ${t.hours}` : null,
    Number(t.seats) > 1 ? `${t.seats} seats, each member checking in on their own` : null,
    Number(t.freezeFee) > 0 ? `Freeze fee ${biz.exact(t.freezeFee)}${Number(t.freezeNoticeDays) ? `, ${t.freezeNoticeDays} days' notice` : ""}` : null,
    Number(t.transferFee) > 0 ? `Transfer fee ${biz.exact(t.transferFee)}` : null,
    Number(t.lateFee) > 0 ? `Late fee ${biz.exact(t.lateFee)} on an instalment more than ${t.lateFeeAfterDays} days overdue` : null,
  ].filter(Boolean);
  if (!lines.length) return null;
  return <><dt>Terms told to the member</dt><dd>{lines.join(" · ")}</dd></>;
}
