import { Fragment, useEffect, useMemo, useState } from "react";
import SearchPicker from "../../../../components/SearchPicker";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { dayWords, splitInstalments, termWords } from "./memberships";

// Selling a membership, renewing one or upgrading one to another plan. The
// bill is worked out by the server as it will be posted (the plan's price as
// the catalogue has it, the member's own prices, offers, the discount, GST)
// and shown as it changes; what is paid now is taken with it, the rest left
// on the member's dues or split into instalments that add up to the bill. A
// renewal starts the day after the membership it renews ends; an upgrade
// starts today and its old membership's unused part pays first.
//   mode: sell | renew | upgrade; member: the member (none: choose or type one);
//   membership: the one renewed or upgraded.

const PAY_KINDS = ["cash", "upi", "card", "bank"];
const PAN_ABOVE = 200000;

export default function MembershipDialog({ mode = "sell", member, membership, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const today = businessToday(biz.business.timezone);
  const { options } = useOptions(["member-plans/plans?active=true"]);
  const plans = useMemo(() => (options?.["member-plans/plans?active=true"] || []), [options]);
  const [chosen, setChosen] = useState(member || null);
  const [form, setForm] = useState(() => ({
    planId: mode === "renew" && membership ? String(membership.plan_id) : "", newMember: false, name: "", phone: "", startOn: today, joining: null,
    locationId: String(biz.currentLocationId || biz.member.location_id || biz.locations[0]?.id || ""), amount: "", method: "cash", reference: "",
    discountAmount: "", discountReason: "", split: false, parts: "4", firstDue: today, instalments: [], pan: "", declaration: false, notes: "",
  }));
  const [figures, setPreview] = useState(null);
  const [problem, setProblem] = useState("");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const plan = plans.find((p) => String(p.id) === String(form.planId));
  const contactId = form.newMember ? null : chosen?.id || null;
  const discount = form.discountAmount ? { discount: { amount: form.discountAmount, reason: form.discountReason } } : {};
  // The figures as the server works them out, each time what decides them changes.
  const asked = JSON.stringify({ planId: form.planId, contactId, startOn: form.startOn, joining: form.joining, discount, locationId: form.locationId });
  // The figures shown are those worked out for what is asked now.
  const preview = figures && figures.asked === asked && form.planId ? figures : null;
  useEffect(() => {
    if (!form.planId || !form.locationId) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const body = mode === "upgrade" ? { planId: form.planId, locationId: form.locationId, ...discount }
        : { planId: form.planId, locationId: form.locationId, ...(contactId ? { contactId } : {}), ...(mode === "renew" ? { renewalOf: membership.id } : { startOn: form.startOn }),
          ...(form.joining === null ? {} : { joiningFee: form.joining }), ...discount };
      const path = mode === "upgrade" ? `member-plans/memberships/${membership.id}/upgrade/preview` : "member-plans/memberships/preview";
      businessWrite(biz.id, path, body).then((p) => { if (!controller.signal.aborted) { setPreview({ ...p, asked }); setProblem(""); } })
        .catch((err) => { if (!controller.signal.aborted) { setPreview(null); setProblem(getErrorMessage(err)); } });
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = preview ? Number(mode === "upgrade" ? preview.newTotal : preview.total) : 0;
  const due = preview ? Number(mode === "upgrade" ? preview.due : preview.total) : 0;
  const joiningShown = mode === "sell" && plan?.joining_sku_id;
  const joiningOn = form.joining === null ? Boolean(preview?.joiningFee) : form.joining;
  const instalments = form.split ? (form.instalments.length ? form.instalments : splitInstalments(total, form.parts, form.firstDue)) : [];
  const instalmentSum = instalments.reduce((s, i) => s + Math.round(Number(i.amount || 0) * 100), 0);
  const big = total > PAN_ABOVE;
  const canPay = biz.can("sales.edit");
  const paying = canPay && form.amount !== "" && Number(form.amount) > 0;
  const submit = () => {
    if (mode === "sell" && !form.newMember && !chosen) throw new Error("Choose the member, or tick a new member and type their name");
    if (!preview) throw new Error(problem || "The bill is still being worked out");
    if (form.split && instalmentSum !== Math.round(total * 100)) throw new Error(`The instalments add up to ${biz.exact(instalmentSum / 100)}, not the bill's ${biz.exact(total)}`);
    const payments = paying ? [{ amount: Math.abs(Number(form.amount) - due) < 0.005 ? "full" : form.amount, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined }] : undefined;
    const common = { requestKey, locationId: form.locationId, planId: form.planId, ...discount, ...(payments ? { payments } : {}),
      ...(form.split ? { instalments: instalments.map((i) => ({ dueOn: i.dueOn, amount: i.amount })) } : {}),
      ...(big ? { buyer: { pan: form.pan.trim() || undefined, panDeclaration: form.declaration } } : {}), notes: form.notes.trim() || undefined };
    if (mode === "upgrade") return businessWrite(biz.id, `member-plans/memberships/${membership.id}/upgrade`, common);
    return businessWrite(biz.id, "member-plans/memberships", { ...common,
      ...(form.newMember ? { member: { name: form.name, phone: form.phone || undefined } } : { contactId: chosen.id }),
      ...(mode === "renew" ? { renewalOf: membership.id } : { startOn: form.startOn }), ...(joiningShown ? { joiningFee: joiningOn } : {}) });
  };
  const titles = { sell: "Sell a membership", renew: `Renew ${membership?.membership_no || ""}`, upgrade: `Upgrade ${membership?.membership_no || ""}` };
  const choices = plans.filter((p) => mode !== "upgrade" || String(p.id) !== String(membership?.plan_id));
  return (
    <FormDialog title={titles[mode]} icon="user-plus" width={760} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={mode === "upgrade" ? "Upgrade and post the bill" : "Post the bill"}
      description={mode === "renew" ? "The renewal starts the day after this membership ends, or today if it ended more than its grace days ago."
        : mode === "upgrade" ? "The new plan starts today. The part of this membership not used comes back as a credit note on its bill, and pays the new bill first."
          : "The bill is posted with the membership; what is not paid now stays on the member's dues."}>
      {mode === "sell" && !member && (
        <>
          {form.newMember ? (
            <>
              <Field label="Member's name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
              <Field label="Phone"><input inputMode="tel" maxLength={30} value={form.phone} onChange={set("phone")} /></Field>
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
            </>
          )}
          {mode !== "upgrade" && (
            <>
              <dt>The bill</dt><dd><strong>{biz.exact(preview.total)}</strong> ({biz.exact(preview.subtotal)} before GST, GST {biz.exact(preview.tax)}{Number(preview.roundOff) ? `, round-off ${biz.exact(preview.roundOff)}` : ""})</dd>
              {(preview.lines || []).map((l, i) => <Fragment key={i}><dt className="muted">{l.label}</dt><dd className="muted">{biz.exact(Number(l.net) + Number(l.tax))} (GST {Number(l.taxRate)}%)</dd></Fragment>)}
            </>
          )}
        </dl>
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
