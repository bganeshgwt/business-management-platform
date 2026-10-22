import { useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import useConfirm from "../../../../hooks/useConfirm";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field, FormError, PeriodFilter } from "../../core/pages/ui";
import { useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { Segmented } from "./shared";

// Claims on suppliers: money the business asks a company to give back
// (scheme money, damaged or expired goods, rate differences, shortages), from
// raised, to sent, to settled by a credit note or rejected.

const KINDS = {
  scheme: "Scheme",
  damage: "Damaged goods",
  expiry: "Expired goods",
  rate_difference: "Rate difference",
  shortage: "Shortage",
  other: "Other",
};

const STATUS = {
  open: { tone: "warning", label: "Open" },
  submitted: { tone: "info", label: "Sent to company" },
  settled: { tone: "success", label: "Settled" },
  rejected: { tone: "neutral", label: "Rejected" },
};

const STATUS_TABS = [
  { value: "open", label: "Open" },
  { value: "submitted", label: "Sent" },
  { value: "settled", label: "Settled" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

const SUPPLIERS = "contacts?kind=supplier&active=true";
const PURCHASES = "documents?kind=purchase";

// A refusal FormDialog shows like the server's own sentence.
const refuse = (message) => Object.assign(new Error(message), { response: { data: { message } } });

function ClaimBadge({ status }) {
  const s = STATUS[status] || { tone: "neutral", label: status };
  return <Badge status={status} tone={s.tone} label={s.label} />;
}

export default function ClaimsPage() {
  const biz = useOpenBusiness();
  const confirm = useConfirm();
  const edit = biz.can("purchasing.edit");
  const [status, setStatus] = useState("open");
  const list = useServerList("claims", { gridId: "wholesale-claims", period: true, params: status !== "all" ? { status } : {} });
  const { reload } = list;
  const [creating, setCreating] = useState(false);
  const [settling, setSettling] = useState(null);

  const columns = useMemo(() => {
    async function change(c, body, done) {
      try {
        await businessWrite(biz.id, `claims/${c.id}`, body, "patch");
        toast.success(done);
        reload();
      } catch (err) {
        toast.error(getErrorMessage(err));
      }
    }
    function markSent(c) {
      change(c, { status: "submitted" }, `Claim on ${c.supplier_name} marked sent`);
    }
    async function reject(c) {
      let note = "";
      const ok = await confirm({
        title: "Mark this claim rejected?",
        message: (
          <div className="stack">
            <p>{c.supplier_name} did not accept the {KINDS[c.kind]?.toLowerCase() || "claim"} claim of {biz.exact(c.amount)}. It is kept, marked rejected.</p>
            <label className="field">
              <span>Note (optional)</span>
              <input maxLength={500} placeholder="Why the company refused" onChange={(e) => { note = e.target.value; }} />
            </label>
          </div>
        ),
        confirmLabel: "Mark rejected",
      });
      if (!ok) return;
      change(c, { status: "rejected", ...(note.trim() ? { notes: note.trim() } : {}) }, `Claim on ${c.supplier_name} marked rejected`);
    }
    return [
      { key: "date", header: "Date", type: "date", value: (c) => c.created_at, render: (c) => dateShort(c.created_at) },
      { key: "supplier", header: "Supplier", value: (c) => c.supplier_name, mobile: "title", pin: true },
      { key: "kind", header: "Type", value: (c) => KINDS[c.kind] || c.kind, mobile: "subtitle", filter: "select" },
      { key: "bill", header: "Purchase", value: (c) => c.document_no || "", defaultHidden: true },
      { key: "period", header: "For the period", value: (c) => c.period_from || "",
        render: (c) => (c.period_from ? `${dateShort(c.period_from)} – ${dateShort(c.period_to)}` : ""), defaultHidden: true },
      { key: "amount", header: "Amount claimed", type: "money", exact: true, value: (c) => Number(c.amount), total: "sum", mobile: "show" },
      { key: "status", header: "Status", type: "status", value: (c) => c.status, render: (c) => <ClaimBadge status={c.status} />, mobile: "show" },
      { key: "settled", header: "Settled", type: "money", exact: true, value: (c) => (c.settled_amount == null ? null : Number(c.settled_amount)), total: "sum",
        render: (c) => (c.settled_amount == null ? "" : biz.exact(c.settled_amount)) },
      { key: "credit_note", header: "Credit note no.", value: (c) => c.credit_note_no || "" },
      { key: "notes", header: "Notes", value: (c) => c.notes || "", defaultHidden: true },
      { key: "by", header: "Raised by", value: (c) => c.created_by_name || "", defaultHidden: true },
      edit && { key: "actions", header: "", label: "Actions", type: "actions", render: (c) => (
        (c.status === "open" || c.status === "submitted") ? (
          <div className="row-actions">
            {c.status === "open" && <button type="button" className="chip-button" onClick={() => markSent(c)}>Mark sent</button>}
            <button type="button" className="chip-button" onClick={() => setSettling(c)}>Settled…</button>
            <button type="button" className="chip-button" onClick={() => reject(c)}>Rejected</button>
          </div>
        ) : null
      ) },
    ].filter(Boolean);
  }, [edit, biz, confirm, reload]);

  return (
    <div className="stack">
      <BusinessHeader icon="receipt" title="Claims on suppliers"
        description="What you claim back from a company: scheme money, damaged or expired goods, rate differences and shortages. Free goods on a purchase are entered on the purchase as a line at ₹0."
        primary={edit && <button type="button" className="button" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> New claim</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Claims in this period">
        <DataGrid {...list.gridProps} caption="Claims on suppliers" columns={columns} currency={biz.symbol} rowNoun={["claim", "claims"]}
          toolbar={<><PeriodFilter list={list} /><Segmented label="Show" value={status} options={STATUS_TABS} onChange={setStatus} /></>}
          exportName={biz.can("purchasing.export") ? `${biz.business.code}-supplier-claims` : undefined}
          rowClassName={(c) => (c.status === "rejected" ? "dg-tone-muted" : "")}
          empty="No claims in these dates" emptyHint="Pick other dates or another tab above." emptyIcon="receipt" />
      </SectionCard>
      {creating && <ClaimDialog onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); }} />}
      {settling && <SettleDialog claim={settling} onClose={() => setSettling(null)} onSaved={() => { setSettling(null); reload(); }} />}
    </div>
  );
}

function ClaimDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions([SUPPLIERS, PURCHASES]);
  const suppliers = options?.[SUPPLIERS] || [];
  const [supplier, setSupplier] = useState(null);
  const [form, setForm] = useState({ kind: "scheme", amount: "", documentId: "", periodFrom: "", periodTo: "", notes: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const purchases = supplier ? (options?.[PURCHASES] || []).filter((d) => String(d.contact_id) === String(supplier.id)) : [];
  const submit = () => {
    if (!supplier) return Promise.reject(refuse("Choose the supplier."));
    if (form.periodTo && !form.periodFrom) return Promise.reject(refuse("Enter the start of the period too."));
    return businessWrite(biz.id, "claims", {
      supplierId: supplier.id, kind: form.kind, amount: form.amount,
      ...(form.documentId ? { documentId: form.documentId } : {}),
      ...(form.periodFrom ? { periodFrom: form.periodFrom } : {}),
      ...(form.periodTo ? { periodTo: form.periodTo } : {}),
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    });
  };
  return (
    <FormDialog title="New claim" icon="receipt" width={600} submitLabel="Save claim"
      successMessage={`Claim on ${supplier?.name || "the supplier"} saved`} onSubmit={submit} onClose={onClose} onSaved={onSaved}>
      <FormError message={error} />
      <div className="field-wide">
        <SearchPicker label="Supplier" required value={supplier} options={suppliers}
          onChange={(next) => { setSupplier(next); setForm((f) => ({ ...f, documentId: "" })); }}
          getKey={(s) => s.id} getLabel={(s) => s.name} getDescription={(s) => s.phone || ""}
          getKeywords={(s) => `${s.phone || ""} ${s.gstin || ""}`} placeholder="Supplier name or phone" />
      </div>
      <Field label="Type of claim">
        <select required value={form.kind} onChange={set("kind")}>
          {Object.entries(KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Field>
      <Field label={`Amount claimed (${biz.symbol})`}>
        <input type="number" min="0.01" step="0.01" required value={form.amount} onChange={set("amount")} />
      </Field>
      <Field label="Against purchase (optional)" wide hint={supplier && !purchases.length ? "No purchases from this supplier yet" : undefined}>
        <select value={form.documentId} onChange={set("documentId")} disabled={!supplier || !purchases.length}>
          <option value="">{supplier ? "Not against one purchase" : "Choose the supplier first"}</option>
          {purchases.map((d) => (
            <option key={d.id} value={String(d.id)}>
              {d.document_no}{d.created_at ? ` · ${dateShort(d.created_at)}` : ""}{d.total != null ? ` · ${biz.exact(d.total)}` : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Period from (optional)" hint="For scheme claims over a period">
        <input type="date" value={form.periodFrom} onChange={set("periodFrom")} />
      </Field>
      <Field label="Period to (optional)">
        <input type="date" min={form.periodFrom || undefined} value={form.periodTo} onChange={set("periodTo")} />
      </Field>
      <Field label="Notes (optional)" wide>
        <textarea rows={2} maxLength={500} value={form.notes} onChange={set("notes")} />
      </Field>
    </FormDialog>
  );
}

function SettleDialog({ claim, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState(() => ({ settledAmount: String(Number(claim.amount)), creditNoteNo: "", notes: "" }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = () => businessWrite(biz.id, `claims/${claim.id}`, {
    status: "settled", settledAmount: form.settledAmount, creditNoteNo: form.creditNoteNo.trim(),
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
  }, "patch");
  return (
    <FormDialog title={`Settle claim · ${claim.supplier_name}`} icon="check-circle" width={520} submitLabel="Mark settled"
      description={`${KINDS[claim.kind] || claim.kind} claim of ${biz.exact(claim.amount)}. Enter what the company agreed and its credit note number.`}
      successMessage={`Claim on ${claim.supplier_name} settled`} onSubmit={submit} onClose={onClose} onSaved={onSaved}>
      <Field label={`Amount settled (${biz.symbol})`} hint="Can be less than claimed">
        <input type="number" min="0" step="0.01" required value={form.settledAmount} onChange={set("settledAmount")} />
      </Field>
      <Field label="Credit note no.">
        <input required maxLength={60} value={form.creditNoteNo} onChange={set("creditNoteNo")} />
      </Field>
      <Field label="Notes (optional)" wide>
        <textarea rows={2} maxLength={500} value={form.notes} onChange={set("notes")} />
      </Field>
    </FormDialog>
  );
}
