import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import MembershipDialog from "./MembershipDialog";
import { INSTALMENT_STATUSES, dayWords, endWords, feesMessage, messageLink, renewalMessage, statusOf } from "./memberships";
// A renewal reminder (a WhatsApp or a call) needs the member's consent to reminders (asked first, in one tap).
import ConsentLink from "../../../personal-data/components/ConsentLink";
import { useConsentGate } from "../../../personal-data/useConsentGate";
import { useShopPrivacy } from "../../../personal-data/usePrivacy";
import "../../fashion/styles/business-fashion-electronics.css";
import "../styles/memberships.css";

// Renewals: the calls to make. Memberships ending in the next 7 or 15 days
// and those that ended in the last 30, not yet renewed and with nothing else
// running after them; and the fees in instalments falling due or overdue.
// WhatsApp opens with the message ready (or a call), and each reminder is
// kept; a renewal is sold from the row, and an instalment collected as a
// receipt against its bill (the shared collections).

const TABS = [["soon7", "Ending in 7 days"], ["soon15", "Ending in 15 days"], ["ended", "Ended in the last 30 days"], ["fees", "Fees due"]];
const COLLECT_KINDS = ["cash", "upi", "card", "bank", "cheque"];

export default function RenewalsPage() {
  const biz = useOpenBusiness();
  const [params] = useSearchParams();
  const money = biz.can("sales.view");
  const [tab, setTab] = useState(() => (params.get("show") === "fees" && money ? "fees" : "soon7"));
  const [renewing, setRenewing] = useState(null);
  const [collecting, setCollecting] = useState(null);
  const fees = tab === "fees";
  const list = useServerList(fees ? "member-plans/instalments" : "member-plans/renewals", { gridId: fees ? "member-fees-due" : "member-renewals",
    params: fees ? { open: "true" } : { [tab]: "true" } });
  const privacy = useShopPrivacy();
  const gate = useConsentGate(privacy);
  const record = (row, kind, channel) => businessWrite(biz.id, `member-plans/memberships/${row.membership_id || row.id}/reminders`, { kind, channel })
    .then(() => { toast.success(`Reminder to ${row.member_name} noted.`); list.reload(); })
    .catch((err) => toast.error(getErrorMessage(err)));
  // With the member's consent to reminders (asked first): WhatsApp opens with the message, then it is kept.
  const remind = async (row, kind, text) => {
    if (!(await gate.ensure("reminders", { id: row.contact_id, name: row.member_name }))) return;
    if (row.member_phone) window.open(messageLink(row.member_phone, text), "_blank", "noopener");
    record(row, kind, "whatsapp");
  };
  const canRenew = biz.can("member_plans.create") && biz.can("sales.create");
  const canCollect = biz.has("receivables") && biz.can("receivables.create");
  const member = (r) => <Link to={biz.path(`members/${r.contact_id}`)} className="bz-two-line"><span>{r.member_name}</span><small className="muted mono">{r.member_code}</small></Link>;
  const contact = (r, kind, text) => (
    <>
      {r.member_phone && <button type="button" className="chip-button" onClick={() => remind(r, kind, text)}><Icon name="message" size={14} /> WhatsApp</button>}
      {r.member_phone && (
        <ConsentLink privacy={privacy} purpose="reminders" person={{ id: r.contact_id, name: r.member_name }} href={`tel:${r.member_phone.replace(/[^\d+]/g, "")}`}
          onSent={() => record(r, kind, "call")}><Icon name="phone" size={14} /> Call</ConsentLink>
      )}
    </>
  );
  const renewalColumns = useMemo(() => [
    { key: "member_name", header: "Member", value: (r) => `${r.member_name} ${r.member_code || ""}`, mobile: "title", pin: true, render: member },
    { key: "plan_name", header: "Membership", value: (r) => r.plan_name, render: (r) => <span className="bz-two-line"><span>{r.plan_name}</span><small className="muted mono">{r.membership_no}</small></span> },
    { key: "end_on", header: "Last day", type: "date", value: (r) => r.end_on, mobile: "subtitle",
      render: (r) => <span className="bz-two-line"><span className={Number(r.days_left) < 0 ? "bz-minus" : ""}>{dayWords(r.end_on)}</span><small className="muted">{endWords(r)}</small></span> },
    { key: "status", header: "Status", value: (r) => statusOf(r).label, render: (r) => <Badge tone={statusOf(r).tone} label={statusOf(r).label} /> },
    { key: "member_phone", header: "Phone", value: (r) => r.member_phone || "", defaultHidden: true },
    { key: "last_reminded_at", header: "Last reminded", type: "date", value: (r) => r.last_reminded_at,
      render: (r) => (r.last_reminded_at ? <span className="bz-two-line"><span>{dateShort(r.last_reminded_at)}</span><small className="muted">{r.reminders} {r.reminders === 1 ? "reminder" : "reminders"}</small></span> : <span className="muted">Never</span>) },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      <span className="bz-row-actions">
        {contact(r, "renewal", renewalMessage(biz, r))}
        {canRenew && <button type="button" className="chip-button" onClick={() => setRenewing(r)}><Icon name="refresh" size={14} /> Renew</button>}
      </span>
    ) },
  ], [biz, canRenew]); // eslint-disable-line react-hooks/exhaustive-deps
  const feeColumns = useMemo(() => [
    { key: "member_name", header: "Member", value: (r) => `${r.member_name} ${r.member_code || ""}`, mobile: "title", pin: true, render: member },
    { key: "plan_name", header: "Fees of", value: (r) => r.plan_name, render: (r) => <span className="bz-two-line"><span>{r.plan_name}</span><small className="muted mono">{r.membership_no} · {r.document_no}</small></span> },
    { key: "seq", header: "Instalment", value: (r) => `${r.seq} of ${r.instalments}` },
    { key: "due_on", header: "Due on", type: "date", value: (r) => r.due_on, mobile: "subtitle",
      render: (r) => <span className="bz-two-line"><span className={r.overdue ? "bz-minus" : ""}>{dayWords(r.due_on)}</span><small className="muted">{r.overdue ? `${r.days_overdue} days overdue` : ""}</small></span> },
    { key: "left_to_pay", header: "To pay", type: "money", exact: true, value: (r) => Number(r.left_to_pay), total: "sum", mobile: "show" },
    { key: "status", header: "", value: (r) => INSTALMENT_STATUSES[r.status]?.label, render: (r) => <Badge tone={INSTALMENT_STATUSES[r.status]?.tone} label={INSTALMENT_STATUSES[r.status]?.label} /> },
    { key: "last_reminded_at", header: "Last reminded", type: "date", value: (r) => r.last_reminded_at,
      render: (r) => (r.last_reminded_at ? dateShort(r.last_reminded_at) : <span className="muted">Never</span>) },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      <span className="bz-row-actions">
        {contact(r, "fees", feesMessage(biz, r, biz.exact))}
        {canCollect && <button type="button" className="chip-button" onClick={() => setCollecting(r)}><Icon name="wallet" size={14} /> Collect</button>}
      </span>
    ) },
  ], [biz, canCollect]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <BusinessHeader icon="refresh" title="Renewals"
        description="Memberships ending soon or ended lately, not yet renewed, and fees falling due. WhatsApp opens with the message ready; each reminder is kept." />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon={fees ? "wallet" : "calendar"} title={TABS.find(([value]) => value === tab)[1]}>
        <div className="fe-chips" role="group" aria-label="Which list">
          {TABS.filter(([value]) => value !== "fees" || money).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={tab === value} className={`fe-chip ${tab === value ? "is-active" : ""}`} onClick={() => setTab(value)}>{label}</button>
          ))}
        </div>
        <DataGrid key={fees ? "fees" : "renewals"} {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Member, phone, code or plan" }}
          caption={fees ? "Fees due" : "Renewals"} columns={fees ? feeColumns : renewalColumns} currency={biz.symbol}
          rowKey={(r) => (fees ? `${r.membership_id}-${r.seq}` : r.id)} rowNoun={fees ? ["instalment", "instalments"] : ["membership", "memberships"]}
          rowClassName={(r) => (fees ? (r.overdue ? "dg-tone-danger" : "") : Number(r.days_left) < 0 ? "dg-tone-warning" : "")}
          exportName={biz.can("member_plans.export") ? `${biz.business.code}-${fees ? "fees-due" : "renewals"}` : undefined}
          empty={fees ? "No fees are due" : "Nothing to call about"} emptyHint={fees ? "Instalments show here as they fall due." : "Memberships show here as they come near their end."}
          emptyIcon={fees ? "wallet" : "calendar"} />
      </SectionCard>
      {renewing && <MembershipDialog mode="renew" member={{ id: renewing.contact_id, name: renewing.member_name }} membership={renewing} onClose={() => setRenewing(null)}
        onSaved={(m) => { setRenewing(null); toast.success(`Renewed: ${m.membership_no} from ${dayWords(m.start_on)}.`); list.reload(); }} />}
      {collecting && <CollectDialog row={collecting} onClose={() => setCollecting(null)} onSaved={(k) => { setCollecting(null); toast.success(`Receipt ${k.collection_no} for ${biz.exact(k.amount)}.`); list.reload(); }} />}
      {gate.dialog}
    </div>
  );
}

// An instalment collected: a receipt of the shared collections, set against the membership's bill.
function CollectDialog({ row, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: Number(row.left_to_pay).toFixed(2), method: "cash", reference: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = () => businessWrite(biz.id, "collections", { requestKey, locationId: row.location_id, contactId: row.contact_id, amount: form.amount,
    ...methods.body(form.method, COLLECT_KINDS), reference: form.reference.trim() || undefined, allocations: [{ documentId: row.document_id, amount: form.amount }],
    notes: `Instalment ${row.seq} of ${row.membership_no}` });
  return (
    <FormDialog title={`Collect from ${row.member_name}`} icon="wallet" width={560} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Take the payment"
      description={`Instalment ${row.seq} of ${row.instalments} of ${row.plan_name} (${row.membership_no}), due ${dayWords(row.due_on)}: ${biz.exact(row.left_to_pay)} to pay. A receipt is made against bill ${row.document_no}.`}>
      <Field label="Amount"><input type="number" required min="0.01" step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid by"><select value={methods.resolve(form.method, COLLECT_KINDS)} onChange={set("method")}>{methods.options(COLLECT_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      <Field label="Reference (optional)" hint="The cheque number for a cheque." wide><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
    </FormDialog>
  );
}
