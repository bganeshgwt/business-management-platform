import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import api, { getErrorMessage } from "../../../../services/api";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { toast } from "../../../../services/toast";
import { dateTime } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { SignaturePad } from "../../../tasks/pages/parts";
import "../../../tasks/styles/tasks.css";
import { ADDON_KINDS, FEE_WORDS, dayWords, messageLink } from "./memberships";

// What a member's page shows beyond the membership's own terms: a shared
// membership's seats, its add-ons (ending with it), the fees billed on it,
// money to go back (refunds due), a changed instalment schedule and the
// late fee, the member's signature accepting the refund policy, and a
// coaching student's details, guardians and test results.

const PAY_KINDS = ["cash", "upi", "card", "bank"];

// --- On a membership ---------------------------------------------------------------------------------

export function MembershipExtras({ m, member, onChanged }) {
  const biz = useOpenBusiness();
  const [dialog, setDialog] = useState(null);
  const money = m.money !== false;
  const running = ["upcoming", "active", "frozen"].includes(m.status) || (m.status === "expired" && m.in_grace);
  const canEdit = biz.can("member_plans.edit");
  const roster = m.seat_members || [];
  const seats = roster.filter((s) => !s.removed_at);
  const done = (message) => { setDialog(null); onChanged(message); };
  const removeSeat = (seat) => businessWrite(biz.id, `member-plans/memberships/${m.id}/seats/${seat.id}/remove`, {})
    .then(() => onChanged(`${seat.name} gave up the seat.`)).catch((err) => toast.error(getErrorMessage(err)));
  const lateFee = (i) => businessWrite(biz.id, `member-plans/memberships/${m.id}/late-fee`, { requestKey: newKey(), seq: i.seq })
    .then(() => onChanged(`Late fee billed on instalment ${i.seq}.`)).catch((err) => toast.error(getErrorMessage(err)));
  return (
    <div className="mem-extras">
      {roster.length > 0 && (
        <div className="mem-extra">
          <strong>Seats</strong>
          <ul className="mem-list">
            {roster.map((s) => (
              <li key={s.id} className={s.removed_at ? "muted" : ""}>
                {s.name} <span className="mono muted">{s.member_code}</span>{s.removed_at ? " · gave it up" : ""}
                {!s.removed_at && canEdit && !m.closed && <button type="button" className="chip-button" onClick={() => removeSeat(s)}>Give up</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {canEdit && !m.closed && Number(m.seats) > 1 && seats.length < Number(m.seats) && (
        <button type="button" className="button button-secondary button-sm" onClick={() => setDialog("seat")}><Icon name="users" size={14} /> Give a seat</button>
      )}
      {(m.addons || []).length > 0 && (
        <div className="mem-extra">
          <strong>Add-ons</strong>
          <ul className="mem-list">
            {m.addons.map((a) => <li key={a.id}>{a.label}{money && a.amount ? ` · ${biz.exact(a.amount)}` : ""} · <span className="mono">{a.document_no}</span> · ends {a.ends_on ? dayWords(a.ends_on) : "with the pack"}</li>)}
          </ul>
        </div>
      )}
      {running && biz.can("member_plans.create") && biz.can("sales.create") && (
        <button type="button" className="button button-secondary button-sm" onClick={() => setDialog("addon")}><Icon name="plus" size={14} /> Add-on</button>
      )}
      {money && (m.fees || []).length > 0 && (
        <div className="mem-extra">
          <strong>Fees billed</strong>
          <ul className="mem-list">{m.fees.map((f) => <li key={f.id}>{FEE_WORDS[f.kind]}{f.instalment_seq ? ` (instalment ${f.instalment_seq})` : ""} · {biz.exact(f.amount)} · <span className="mono">{f.document_no}</span></li>)}</ul>
        </div>
      )}
      {money && (m.refunds_due || []).length > 0 && (
        <div className="mem-extra">
          <strong>Money to go back</strong>
          <ul className="mem-list">
            {m.refunds_due.map((r) => (
              <li key={r.id}>{biz.exact(r.amount)} · {r.refund_id ? `refunded ${dateTime(r.paid_at)}` : `due ${dayWords(r.due_on)}`}
                {!r.refund_id && biz.can("member_plans.refund") && <button type="button" className="chip-button" onClick={() => setDialog({ refund: r })}>Pay it</button>}</li>
            ))}
          </ul>
        </div>
      )}
      {money && (m.instalments || []).some((i) => i.late_fee && !i.late_fee_billed) && biz.can("sales.create") && canEdit && (
        <div className="mem-extra">
          {m.instalments.filter((i) => i.late_fee && !i.late_fee_billed).map((i) => (
            <button key={i.seq} type="button" className="button button-secondary button-sm" onClick={() => lateFee(i)}>Bill the late fee of instalment {i.seq} ({biz.exact(i.late_fee)} before GST)</button>
          ))}
        </div>
      )}
      {money && (m.instalments || []).length > 0 && !m.closed && biz.can("member_plans.approve") && (
        <button type="button" className="button button-secondary button-sm" onClick={() => setDialog("instalments")}>Change the instalments</button>
      )}
      {(m.acceptances || []).length > 0 && (
        <div className="mem-extra">
          <strong>Refund policy signed</strong>
          <ul className="mem-list">{m.acceptances.map((a) => <li key={a.id}>{a.signed_by_name} · version {a.policy_version} · {dateTime(a.created_at)}
            <button type="button" className="chip-button" onClick={() => setDialog({ signature: a })}>See the signature</button></li>)}</ul>
        </div>
      )}
      {biz.can("member_plans.create") && (
        <button type="button" className="button button-secondary button-sm" onClick={() => setDialog("sign")}><Icon name="edit" size={14} /> The member signs the policy</button>
      )}
      {dialog === "seat" && <SeatDialog m={m} onClose={() => setDialog(null)} onSaved={() => done("Seat given.")} />}
      {dialog === "addon" && <AddonDialog m={m} onClose={() => setDialog(null)} onSaved={() => done("Add-on sold.")} />}
      {dialog === "instalments" && <InstalmentsDialog m={m} onClose={() => setDialog(null)} onSaved={() => done("Instalments changed.")} />}
      {dialog?.refund && <RefundDialog row={dialog.refund} onClose={() => setDialog(null)} onSaved={() => done("Refund paid.")} />}
      {dialog === "sign" && <SignDialog m={m} member={member} onClose={() => setDialog(null)} onSaved={() => done("Signature kept.")} />}
      {dialog?.signature && <SignatureView acceptance={dialog.signature} onClose={() => setDialog(null)} />}
    </div>
  );
}

function SeatDialog({ m, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [who, setWho] = useState(null);
  const [form, setForm] = useState({ newMember: false, name: "", phone: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => {
    if (!form.newMember && !who) throw new Error("Choose the member, or tick a new member");
    return businessWrite(biz.id, `member-plans/memberships/${m.id}/seats`, form.newMember ? { member: { name: form.name, phone: form.phone || undefined } } : { contactId: who.id });
  };
  return (
    <FormDialog title={`A seat on ${m.membership_no}`} icon="users" width={560} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Give the seat"
      description="The member who takes the seat checks in on their own, with a member code of their own.">
      {form.newMember ? (
        <>
          <Field label="Name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
          <Field label="Phone"><input inputMode="tel" maxLength={30} value={form.phone} onChange={set("phone")} /></Field>
        </>
      ) : (
        <div className="field-wide">
          <SearchPicker label="Member" placeholder="Name or phone" value={who} onChange={setWho} minChars={2}
            search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
            getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
        </div>
      )}
      {biz.can("contacts.create") && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.newMember} onChange={set("newMember")} /> A new member</label>}
    </FormDialog>
  );
}

function AddonDialog({ m, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [item, setItem] = useState(null);
  const [form, setForm] = useState({ kind: "locker", lockerNo: "", pay: true, method: "cash" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => {
    if (!item) throw new Error("Choose the add-on's item");
    return businessWrite(biz.id, `member-plans/memberships/${m.id}/addons`, { requestKey, skuId: item.id, kind: form.kind, ...(form.kind === "locker" ? { lockerNo: form.lockerNo } : {}),
      ...(form.pay && biz.can("sales.edit") ? { payments: [{ amount: "full", ...methods.body(form.method, PAY_KINDS) }] } : {}) });
  };
  return (
    <FormDialog title={`An add-on for ${m.membership_no}`} icon="plus" width={600} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Post the bill"
      description={`Billed on its own bill; it ends with the membership${m.end_on ? `, on ${dayWords(m.end_on)}` : ""}.`}>
      <Field label="Kind"><select value={form.kind} onChange={set("kind")}>{ADDON_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
      {form.kind === "locker" && <Field label="Locker number"><input required maxLength={20} className="mono" value={form.lockerNo} onChange={(e) => setForm((f) => ({ ...f, lockerNo: e.target.value.toUpperCase() }))} /></Field>}
      <div className="field-wide">
        <SearchPicker label="Item" placeholder="A service such as Locker" value={item} onChange={setItem} minChars={1}
          search={(q, { signal }) => businessRead(biz.id, "catalog", { kind: "service", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
          getLabel={(s) => s.label} getDescription={(s) => (s.price !== undefined ? `${biz.exact(s.price)} + GST ${Number(s.tax_rate)}%` : "")} />
      </div>
      {biz.can("sales.edit") && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.pay} onChange={set("pay")} /> Paid now</label>}
      {form.pay && biz.can("sales.edit") && <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</select></Field>}
    </FormDialog>
  );
}

function InstalmentsDialog({ m, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [rows, setRows] = useState(() => m.instalments.map((i) => ({ dueOn: i.due_on, amount: Number(i.amount).toFixed(2) })));
  const [reason, setReason] = useState("");
  const total = m.instalments.reduce((s, i) => s + Math.round(Number(i.amount) * 100), 0);
  const sum = rows.reduce((s, i) => s + Math.round(Number(i.amount || 0) * 100), 0);
  const setRow = (n, change) => setRows((all) => all.map((x, k) => (k === n ? { ...x, ...change } : x)));
  const submit = () => {
    if (sum !== total) throw new Error(`The instalments add up to ${biz.exact(sum / 100)}: they keep the total of ${biz.exact(total / 100)}`);
    return businessWrite(biz.id, `member-plans/memberships/${m.id}/instalments`, { reason, instalments: rows }, "put");
  };
  return (
    <FormDialog title={`Change the instalments of ${m.membership_no}`} icon="calendar" width={620} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Save the schedule"
      description="Due days and amounts change; the total stays. The schedule before is kept, and the change is in the activity log.">
      <div className="field-wide mem-instalments">
        {rows.map((r, n) => (
          <div key={n} className="mem-instalment">
            <span className="muted">{n + 1}</span>
            <input type="date" aria-label={`Instalment ${n + 1}: due on`} value={r.dueOn} onChange={(e) => setRow(n, { dueOn: e.target.value })} />
            <input type="number" min="0.01" step="0.01" aria-label={`Instalment ${n + 1}: amount`} value={r.amount} onChange={(e) => setRow(n, { amount: e.target.value })} />
            {rows.length > 2 && <button type="button" className="chip-button" onClick={() => setRows((all) => all.filter((_, k) => k !== n))}>Remove</button>}
          </div>
        ))}
        <button type="button" className="chip-button" onClick={() => setRows((all) => [...all, { dueOn: all.at(-1)?.dueOn || "", amount: "0.00" }])}>Add an instalment</button>
        <small className={sum === total ? "muted" : "bz-minus"}>Adds up to {biz.exact(sum / 100)} of {biz.exact(total / 100)}.</small>
      </div>
      <Field label="Reason" wide><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The parent asked for three instalments" /></Field>
    </FormDialog>
  );
}

function RefundDialog({ row, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [method, setMethod] = useState("cash");
  return (
    <FormDialog title="Pay the refund" icon="wallet" width={480} onClose={onClose} onSaved={onSaved} submitLabel="Pay it now"
      description={`${biz.exact(row.amount)} goes back${row.due_on ? `, due ${dayWords(row.due_on)}` : ""}.`}
      onSubmit={() => businessWrite(biz.id, `member-plans/refunds/${row.id}/pay`, methods.body(method, PAY_KINDS))}>
      <Field label="Refunded by"><select value={methods.resolve(method, PAY_KINDS)} onChange={(e) => setMethod(e.target.value)}>{methods.options(PAY_KINDS).map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</select></Field>
    </FormDialog>
  );
}

// The member signs on the screen, accepting the refund policy as sold.
function SignDialog({ m, member, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const people = [{ id: m.contact_id, name: m.member_name || member.name }, ...(m.seat_members || []).filter((s) => !s.removed_at && String(s.contact_id) !== String(m.contact_id)).map((s) => ({ id: s.contact_id, name: s.name }))];
  const [who, setWho] = useState(String(people[0].id));
  const save = async (file) => {
    const form = new FormData();
    form.append("membershipId", String(m.id));
    form.append("contactId", who);
    form.append("file", file);
    await api.post(`/businesses/${biz.id}/member-plans/acceptances`, form);
    onSaved();
  };
  return (
    <FormDialog title={`${m.membership_no}: the refund policy signed`} icon="edit" width={640} onClose={onClose} hideSubmit
      description={`Version ${m.policy_version}, as sold: ${m.policy}`}>
      {people.length > 1 && <Field label="Signed by"><select value={who} onChange={(e) => setWho(e.target.value)}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
      <div className="field-wide"><SignaturePad onCancel={onClose} onSave={save} /></div>
      <small className="muted field-wide">The signature is kept privately with the membership and never changed; the printed slip stays an option.</small>
    </FormDialog>
  );
}

function SignatureView({ acceptance, onClose }) {
  const biz = useOpenBusiness();
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let gone = false, made = null;
    api.get(`/businesses/${biz.id}/member-plans/acceptances/${acceptance.id}`, { responseType: "blob" })
      .then((response) => { if (!gone) { made = URL.createObjectURL(response.data); setUrl(made); } }).catch(() => {});
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [biz.id, acceptance.id]);
  return (
    <FormDialog title={`Signed by ${acceptance.signed_by_name}`} icon="edit" width={560} onClose={onClose} hideSubmit
      description={`Version ${acceptance.policy_version} of the refund policy, ${dateTime(acceptance.created_at)}.`}>
      <div className="field-wide">{url ? <img src={url} alt={`Signature of ${acceptance.signed_by_name}`} className="mem-signature" /> : <span className="muted">Loading the signature…</span>}</div>
    </FormDialog>
  );
}

// --- A coaching student ---------------------------------------------------------------------------------

export function StudentCard({ data, onChanged }) {
  const biz = useOpenBusiness();
  const { member, guardians = [], results = [] } = data;
  const [dialog, setDialog] = useState(null);
  const canEdit = biz.can("member_plans.edit");
  const done = (message) => { setDialog(null); onChanged(message); };
  return (
    <SectionCard icon="user" title="Details and progress" description="Date of birth (for the birthday list); a student's school and class, guardians with their WhatsApp consent, and test results as progress."
      actions={canEdit && (
        <span className="bz-row-actions">
          <button type="button" className="button button-secondary button-sm" onClick={() => setDialog("profile")}>Details</button>
          <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ guardian: {} })}>Add a guardian</button>
          <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ result: {} })}>Add a test result</button>
        </span>
      )}>
      <dl className="fe-facts">
        <dt>Date of birth</dt><dd>{member.date_of_birth ? `${dayWords(member.date_of_birth)} (age ${member.age})` : "—"}</dd>
        <dt>School and class</dt><dd>{[member.school, member.class_name ? `class ${member.class_name}` : null].filter(Boolean).join(", ") || "—"}</dd>
      </dl>
      {guardians.length > 0 && (
        <ul className="mem-list">
          {guardians.map((g) => (
            <li key={g.id} className={g.active ? "" : "muted"}>
              <strong>{g.name}</strong>{g.relation ? ` (${g.relation})` : ""}{g.phone ? ` · ${g.phone}` : ""}
              {" "}<Badge tone={g.whatsapp_consent ? "success" : "neutral"} label={g.whatsapp_consent ? "Agreed to WhatsApp" : "No WhatsApp"} />
              {g.whatsapp_consent && g.phone && g.active && <a className="chip-button" href={messageLink(g.phone, `Namaste ${g.name}, `)} target="_blank" rel="noopener noreferrer">WhatsApp</a>}
              {canEdit && <button type="button" className="chip-button" onClick={() => setDialog({ guardian: g })}>Change</button>}
            </li>
          ))}
        </ul>
      )}
      {results.length > 0 && (
        <div className="mem-progress" role="list" aria-label="Test results">
          {results.map((r) => (
            <div key={r.id} className="mem-progress-row" role="listitem">
              <span className="mem-progress-name">{r.test_name}<small className="muted"> · {dayWords(r.taken_on)}</small></span>
              <span className="mem-progress-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Number(r.percent))}%` }} /></span>
              <span className="mem-progress-marks">{Number(r.marks)} / {Number(r.out_of)} ({r.percent}%)</span>
              {r.remarks && <small className="muted mem-progress-remarks">{r.remarks}</small>}
              {canEdit && <button type="button" className="chip-button" onClick={() => setDialog({ result: r })}>Change</button>}
            </div>
          ))}
        </div>
      )}
      {dialog === "profile" && <ProfileDialog member={member} onClose={() => setDialog(null)} onSaved={() => done("Details saved.")} />}
      {dialog?.guardian && <GuardianDialog member={member} guardian={dialog.guardian} onClose={() => setDialog(null)} onSaved={() => done("Guardian saved.")} />}
      {dialog?.result && <ResultDialog member={member} result={dialog.result} onClose={() => setDialog(null)} onSaved={() => done("Result saved.")} />}
    </SectionCard>
  );
}

function ProfileDialog({ member, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ dateOfBirth: member.date_of_birth || "", school: member.school || "", className: member.class_name || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`${member.name}: details`} icon="user" width={520} onClose={onClose} onSaved={onSaved}
      onSubmit={() => businessWrite(biz.id, `member-plans/members/${member.id}/profile`, form, "put")}>
      <Field label="Date of birth"><input type="date" max={businessToday(biz.business.timezone)} value={form.dateOfBirth} onChange={set("dateOfBirth")} /></Field>
      <Field label="School"><input maxLength={150} value={form.school} onChange={set("school")} /></Field>
      <Field label="Class"><input maxLength={40} value={form.className} onChange={set("className")} placeholder="e.g. 10" /></Field>
    </FormDialog>
  );
}

function GuardianDialog({ member, guardian, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(guardian.id);
  const [form, setForm] = useState({ name: guardian.name || "", relation: guardian.relation || "", phone: guardian.phone || "", whatsappConsent: Boolean(guardian.whatsapp_consent),
    active: guardian.active !== false });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => (editing ? businessWrite(biz.id, `member-plans/guardians/${guardian.id}`, form, "put")
    : businessWrite(biz.id, `member-plans/members/${member.id}/guardians`, form));
  return (
    <FormDialog title={editing ? `Change ${guardian.name}` : "Add a guardian"} icon="users" width={540} onClose={onClose} onSaved={onSaved} onSubmit={submit}>
      <Field label="Guardian's name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
      <Field label="Relation"><input maxLength={40} value={form.relation} onChange={set("relation")} placeholder="e.g. Mother" /></Field>
      <Field label="Phone"><input inputMode="tel" maxLength={30} value={form.phone} onChange={set("phone")} /></Field>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.whatsappConsent} onChange={set("whatsappConsent")} /> Agreed to messages on WhatsApp</label>
      {editing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> Still a guardian to contact</label>}
    </FormDialog>
  );
}

function ResultDialog({ member, result, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(result.id);
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ testName: result.test_name || "", takenOn: result.taken_on || today, marks: result.marks ? String(Number(result.marks)) : "",
    outOf: result.out_of ? String(Number(result.out_of)) : "100", remarks: result.remarks || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = () => (editing ? businessWrite(biz.id, `member-plans/results/${result.id}`, form, "put") : businessWrite(biz.id, `member-plans/members/${member.id}/results`, form));
  return (
    <FormDialog title={editing ? `Change ${result.test_name}` : "Add a test result"} icon="reports" width={560} onClose={onClose} onSaved={onSaved} onSubmit={submit}>
      <Field label="Test"><input required maxLength={150} value={form.testName} onChange={set("testName")} placeholder="e.g. Mock test 3" /></Field>
      <Field label="Taken on"><input type="date" required max={today} value={form.takenOn} onChange={set("takenOn")} /></Field>
      <Field label="Marks"><input type="number" required min="0" step="0.01" value={form.marks} onChange={set("marks")} /></Field>
      <Field label="Out of"><input type="number" required min="0.01" step="0.01" value={form.outOf} onChange={set("outOf")} /></Field>
      <Field label="Remarks (optional)" wide><input maxLength={500} value={form.remarks} onChange={set("remarks")} /></Field>
    </FormDialog>
  );
}
// --- A membership brought in from another system ------------------------------------------------------------

// A running membership entered with its dates, the sessions left and what was paid elsewhere: no bill, never a sale.
export function BringInDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const today = businessToday(biz.business.timezone);
  const [plans, setPlans] = useState([]);
  const [who, setWho] = useState(null);
  const [form, setForm] = useState({ planId: "", newMember: false, name: "", phone: "", startOn: today, endOn: "", sessionsLeft: "", paidElsewhere: "", notes: "",
    locationId: String(biz.currentLocationId || biz.member.location_id || biz.locations[0]?.id || "") });
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "member-plans/plans", { active: "true", limit: 100 }, controller.signal).then((page) => setPlans(page.items)).catch(() => setPlans([]));
    return () => controller.abort();
  }, [biz.id]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const plan = plans.find((p) => String(p.id) === String(form.planId));
  const submit = () => {
    if (!form.newMember && !who) throw new Error("Choose the member, or tick a new member");
    return businessWrite(biz.id, "member-plans/memberships/brought-in", { requestKey, locationId: form.locationId, planId: form.planId, startOn: form.startOn,
      ...(plan?.kind !== "sessions" ? { endOn: form.endOn } : {}), ...(plan?.kind !== "duration" ? { sessionsLeft: form.sessionsLeft } : {}), paidElsewhere: form.paidElsewhere || "0",
      notes: form.notes.trim() || undefined, ...(form.newMember ? { member: { name: form.name, phone: form.phone || undefined } } : { contactId: who.id }) });
  };
  return (
    <FormDialog title="Bring in a membership" icon="user-plus" width={680} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Bring it in"
      description="A membership running in another system, entered with its dates, the sessions left and what was paid there. No bill is made and it is never counted as a sale.">
      {form.newMember ? (
        <>
          <Field label="Member's name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
          <Field label="Phone"><input inputMode="tel" maxLength={30} value={form.phone} onChange={set("phone")} /></Field>
        </>
      ) : (
        <div className="field-wide">
          <SearchPicker label="Member" placeholder="Name or phone" value={who} onChange={setWho} minChars={2}
            search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
            getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
        </div>
      )}
      {biz.can("contacts.create") && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.newMember} onChange={set("newMember")} /> A new member</label>}
      <Field label="Plan"><select required value={form.planId} onChange={set("planId")}><option value="">Choose the plan…</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="Started on"><input type="date" required max={today} value={form.startOn} onChange={set("startOn")} /></Field>
      {plan && plan.kind !== "sessions" && <Field label="Last day"><input type="date" required min={today} value={form.endOn} onChange={set("endOn")} /></Field>}
      {plan && plan.kind !== "duration" && <Field label="Sessions left"><input type="number" required min="1" max="1000" value={form.sessionsLeft} onChange={set("sessionsLeft")} /></Field>}
      <Field label="Paid in the other system"><input type="number" required min="0" step="0.01" value={form.paidElsewhere} onChange={set("paidElsewhere")} /></Field>
      {biz.locations.length > 1 && <Field label="Branch"><select value={form.locationId} onChange={set("locationId")}>{biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} placeholder="e.g. Receipt 4512 of the old software" /></Field>
    </FormDialog>
  );
}
