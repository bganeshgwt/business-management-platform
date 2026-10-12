import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { word } from "../../../../services/businessNav";
import FormDialog from "./FormDialog";
import { ActiveBadge, BusinessHeader, Field } from "./ui";
import { useOpenBusiness, useServerList } from "./hooks";
import { PayablesCard } from "./SupplierPayments";
// Wholesale trade details on the customer form (pro pass D-16).
import TradeDetailsFields from "../../wholesale/pages/TradeDetailsFields";
import { useTradeDetails } from "../../wholesale/pages/tradeDetails";

// Customers or suppliers, with GSTIN, credit terms and what each owes.
export default function ContactsPage({ kind }) {
  const biz = useOpenBusiness();
  const customer = kind === "customer";
  const plural = customer ? word(biz.type, "customers", "Customers") : "Suppliers";
  const singular = plural.toLowerCase().replace(/ & .*/, "").replace(/s$/, "");
  const [params, setParams] = useSearchParams();
  const list = useServerList("contacts", { gridId: `business-${kind}s`, params: { kind } });
  const [editing, setEditing] = useState(() => (params.get("new") === "1" && biz.can("contacts.create") ? {} : null));
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (params.get("new")) setParams({}, { replace: true });
  }, [params, setParams]);

  const columns = useMemo(() => [
    { key: "name", header: "Name", value: (c) => c.name, mobile: "title", pin: true },
    { key: "phone", header: "Phone", value: (c) => c.phone || "", mobile: "subtitle" },
    { key: "gstin", header: "GSTIN", value: (c) => c.gstin || "", className: "mono" },
    customer && { key: "credit_limit", header: "Credit limit", type: "money", value: (c) => (c.credit_limit === null ? null : Number(c.credit_limit)), render: (c) => (c.credit_limit === null ? <span className="muted">No limit</span> : biz.amount(c.credit_limit)) },
    { key: "credit_days", header: "Credit days", type: "number", value: (c) => c.credit_days },
    { key: "balance", header: customer ? "Owes you" : "You owe", type: "money", exact: true, value: (c) => Number(c.balance), total: "sum", mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (c) => (c.active ? "active" : "inactive"), render: (c) => <ActiveBadge active={c.active} /> },
    biz.can("contacts.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (c) => <button type="button" className="chip-button" onClick={() => setEditing(c)}>Edit</button> },
  ], [biz, customer]);

  return (
    <div className="stack">
      <BusinessHeader icon={customer ? "users" : "truck"} title={plural}
        description={customer ? "Who buys from you, their GSTIN for B2B invoices, how much credit they get and what they owe now." : "Who you buy from, their GSTIN, the credit days they give you and what you owe them."}
        actions={biz.can("contacts.create") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add {singular}</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      {!customer && biz.has("purchasing") && biz.can("purchasing.view") && <PayablesCard />}
      <SectionCard flush icon="list" title={`All ${plural.toLowerCase()}`}>
        <DataGrid {...list.gridProps} caption={plural} columns={columns.filter(Boolean)} currency={biz.symbol}
          exportName={biz.can("contacts.export") ? `${biz.business.code}-${kind}s` : undefined}
          rowClassName={(c) => (!c.active ? "dg-tone-muted" : customer && c.credit_limit !== null && Number(c.balance) > Number(c.credit_limit) ? "dg-tone-danger" : "")}
          empty={`No ${plural.toLowerCase()} yet`} emptyIcon="users" />
      </SectionCard>
      {editing && <ContactDialog kind={kind} contact={editing} singular={singular} onClose={() => setEditing(null)}
        onSaved={(c) => { setEditing(null); setNotice(`${c.name} saved.`); list.reload(); }} />}
    </div>
  );
}

function ContactDialog({ kind, contact, singular, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(contact.id);
  const [form, setForm] = useState({
    name: contact.name || "", phone: contact.phone || "", email: contact.email || "", address: contact.address || "", gstin: contact.gstin || "",
    creditLimit: contact.credit_limit ?? "", creditDays: String(contact.credit_days ?? 0), openingBalance: contact.opening_balance && Number(contact.opening_balance) ? contact.opening_balance : "",
    openingBalanceOn: contact.opening_balance_on || "", active: contact.active ?? true,
  });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const trade = useTradeDetails(biz, contact.id, kind === "customer" && biz.has("sales_orders") && biz.can("sales_orders.view") && biz.can("contacts.edit"));
  const submit = async () => {
    const body = { ...form, kind, creditLimit: kind === "customer" ? form.creditLimit : null, openingBalance: form.openingBalance || 0, openingBalanceOn: form.openingBalance ? form.openingBalanceOn : null };
    const saved = editing ? await businessWrite(biz.id, `contacts/${contact.id}`, body, "patch") : await businessWrite(biz.id, "contacts", body);
    if (trade.enabled) await trade.save(saved.id);
    return saved;
  };
  return (
    <FormDialog title={editing ? `Edit ${contact.name}` : `Add a ${singular}`} icon={kind === "customer" ? "user-plus" : "truck"} onClose={onClose} onSaved={onSaved} onSubmit={submit}>
      <Field label="Name" wide><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
      <Field label="Phone"><input maxLength={30} value={form.phone} onChange={set("phone")} /></Field>
      <Field label="Email"><input type="email" maxLength={150} value={form.email} onChange={set("email")} /></Field>
      <Field label="GSTIN" hint="For B2B invoices; checked for typing mistakes."><input maxLength={20} value={form.gstin} onChange={set("gstin")} className="mono" /></Field>
      <Field label="Address"><input maxLength={500} value={form.address} onChange={set("address")} /></Field>
      {kind === "customer" && <Field label="Credit limit" hint="Leave empty for no limit. Sales over it are refused unless paid."><input type="number" min="0" step="0.01" value={form.creditLimit} onChange={set("creditLimit")} /></Field>}
      <Field label="Credit days" hint="Days until an unpaid bill is due."><input type="number" min="0" max="365" step="1" value={form.creditDays} onChange={set("creditDays")} /></Field>
      <Field label="Opening balance" hint={kind === "customer" ? "What they owed when you started (negative if you owed them)." : "What you owed them when you started."}><input type="number" step="0.01" value={form.openingBalance} onChange={set("openingBalance")} /></Field>
      <Field label="Opening balance as of"><input type="date" required={Boolean(Number(form.openingBalance))} value={form.openingBalanceOn} onChange={set("openingBalanceOn")} /></Field>
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Active</label>}
      {trade.enabled && <TradeDetailsFields trade={trade} />}
    </FormDialog>
  );
}
