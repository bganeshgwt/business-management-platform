import { useCallback, useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "./FormDialog";
import { ActiveBadge, BusinessHeader, Field } from "./ui";
import { useOpenBusiness } from "./hooks";
import { forgetPaymentMethods, KIND_WORDS, METHOD_KINDS } from "./paymentMethods";

const KIND_HINTS = {
  cash: "Counted in the drawer; change is given back from cash.",
  upi: "PhonePe, Google Pay, Paytm, BHIM…",
  card: "Debit / credit card machines, meal cards like Sodexo.",
  bank: "NEFT, RTGS or IMPS into a bank account.",
  cheque: "Needs the cheque number; goes to the cheque register.",
};

// The ways this business takes money, named as the shop says them. Each has
// one of five fixed kinds, which decides how the money is counted (cash in
// the drawer, cheques to the register); the kind cannot change once made.
export default function PaymentMethodsPage() {
  const biz = useOpenBusiness();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "payment-methods", { all: true }, controller.signal)
      .then((list) => { setRows(list); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const canEdit = biz.can("settings.edit");

  async function toggle(method) {
    setNotice(""); setError("");
    try {
      const saved = await businessWrite(biz.id, `payment-methods/${method.id}`, { active: !method.active }, "patch");
      forgetPaymentMethods(biz.id);
      setNotice(`${saved.name} switched ${saved.active ? "on" : "off"}.`);
      reload();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  const columns = [
    { key: "name", header: "Method", value: (m) => m.name, mobile: "title", pin: true, render: (m) => <strong>{m.name}</strong> },
    { key: "kind", header: "Kind", value: (m) => KIND_WORDS[m.kind] || m.kind, mobile: "subtitle" },
    { key: "order", header: "Order", type: "number", value: (m) => m.sort_order, mobile: "hide" },
    { key: "active", header: "Status", type: "status", value: (m) => (m.active ? "active" : "inactive"), render: (m) => <ActiveBadge active={m.active} /> },
    canEdit && {
      key: "actions", header: "", label: "Actions", type: "actions",
      render: (m) => (
        <span className="bz-inline">
          <button type="button" className="chip-button" onClick={() => setEditing(m)}>Edit</button>
          <button type="button" className="chip-button" onClick={() => toggle(m)}>{m.active ? "Switch off" : "Switch on"}</button>
        </span>
      ),
    },
  ];
  return (
    <div className="stack">
      <BusinessHeader icon="wallet" title="Payment methods"
        description="The ways you take money, named the way your counter says them: PhonePe, Paytm, Sodexo, your bank account. Each one is cash, UPI, card, bank transfer or cheque, and the day close counts it that way."
        actions={canEdit && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add method</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={rows ? error : ""} />
      <SectionCard flush icon="list" title="Methods" description="Switched-off methods stay on past bills but are no longer offered at the counter.">
        <DataGrid id="business-payment-methods" caption="Payment methods" columns={columns.filter(Boolean)} rows={rows || []} rowKey={(m) => m.id}
          loading={!rows && !error} error={rows ? "" : error} onRetry={reload} rowNoun={["method", "methods"]}
          rowClassName={(m) => (!m.active ? "dg-tone-muted" : "")} empty="No payment methods" />
      </SectionCard>
      {editing && (
        <MethodDialog method={editing} onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); forgetPaymentMethods(biz.id); setNotice(`${m.name} saved.`); reload(); }} />
      )}
    </div>
  );
}

function MethodDialog({ method, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(method.id);
  const [form, setForm] = useState({ name: method.name || "", kind: method.kind || "upi", sortOrder: method.sort_order ?? "", active: method.active ?? true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const body = { name: form.name, active: form.active, ...(form.sortOrder === "" ? {} : { sortOrder: Number(form.sortOrder) }) };
  return (
    <FormDialog title={editing ? `Edit ${method.name}` : "Add a payment method"} icon="wallet" width={520} onClose={onClose} onSaved={onSaved}
      onSubmit={() => (editing ? businessWrite(biz.id, `payment-methods/${method.id}`, body, "patch") : businessWrite(biz.id, "payment-methods", { ...body, kind: form.kind }))}>
      <Field label="Name"><input required maxLength={60} value={form.name} onChange={set("name")} placeholder="e.g. PhonePe" /></Field>
      <Field label="Kind" hint={editing ? "Fixed once created: add a new method for another kind." : KIND_HINTS[form.kind]}>
        <select value={form.kind} onChange={set("kind")} disabled={editing}>
          {METHOD_KINDS.map((k) => <option key={k} value={k}>{KIND_WORDS[k]}</option>)}
        </select>
      </Field>
      <Field label="Order (optional)" hint="Lower comes first at the counter."><input type="number" min="0" max="10000" step="1" value={form.sortOrder} onChange={set("sortOrder")} /></Field>
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Switched on</label>}
    </FormDialog>
  );
}
