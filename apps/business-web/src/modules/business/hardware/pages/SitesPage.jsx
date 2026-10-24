import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { dateShort, dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { ActiveBadge, Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { whatsappLink } from "../../retail/pages/retail";
import { STATES } from "../../quotations/pages/quotation";
import "../styles/hardware.css";

// Sites: a contractor's or builder's sites, each under one customer. Bills,
// quotations and sales orders carry the site; a site's ledger is its bills,
// returns, payments and refunds in date order with what is still due.

const ENTRY_WORDS = { bill: "Bill", return: "Goods back", payment: "Payment", refund: "Refund" };

export default function SitesPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const [customer, setCustomer] = useState(params.get("customer") || "");
  const [openOnly, setOpenOnly] = useState(true);
  const [dueOnly, setDueOnly] = useState(false);
  const { options } = useOptions(["contacts?kind=customer&active=true"]);
  const customers = options?.["contacts?kind=customer&active=true"] || [];
  const list = useServerList("hardware/sites", { gridId: "hardware-sites",
    params: { ...(customer ? { contact: customer } : {}), ...(openOnly ? { active: "true" } : {}), ...(dueOnly ? { has_due: "true" } : {}) } });
  const [editing, setEditing] = useState(() => (params.get("new") === "1" && biz.can("hardware_sites.edit") ? { contact_id: params.get("customer") || "" } : null));
  const [openId, setOpenId] = useState(() => (params.get("site") ? Number(params.get("site")) : null));
  useEffect(() => {
    if (params.get("new") || params.get("site")) setParams((p) => new URLSearchParams(p.get("open") ? { open: p.get("open") } : {}), { replace: true });
  }, [params, setParams]);
  const money = biz.can("sales.view");

  const columns = useMemo(() => [
    { key: "name", header: "Site", value: (s) => s.name, mobile: "title", pin: true,
      render: (s) => <span className="bz-two-line"><button type="button" className="link-button bz-link-left" onClick={() => setOpenId(s.id)}>{s.name}</button>{s.address && <small className="muted">{s.address}</small>}</span> },
    { key: "customer_name", header: "Customer", value: (s) => s.customer_name, mobile: "subtitle" },
    { key: "contact_person", header: "At the site", value: (s) => [s.contact_person, s.phone].filter(Boolean).join(" · "), defaultHidden: false },
    { key: "bill_count", header: "Bills", type: "number", value: (s) => s.bill_count },
    money && { key: "billed", header: "Billed", type: "money", exact: true, value: (s) => Number(s.billed), total: "sum" },
    money && { key: "due", header: "Due", type: "money", exact: true, value: (s) => Number(s.due), total: "sum", mobile: "show" },
    { key: "last_bill_at", header: "Last bill", type: "date", value: (s) => s.last_bill_at, render: (s) => (s.last_bill_at ? dateShort(s.last_bill_at, { year: true }) : <span className="muted">—</span>) },
    { key: "active", header: "Status", type: "status", value: (s) => (s.active ? "Open" : "Closed"), render: (s) => <ActiveBadge active={s.active} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => (
      <span className="bz-row-actions">
        <button type="button" className="chip-button" onClick={() => setOpenId(s.id)}>Ledger</button>
        {biz.can("hardware_sites.edit") && <button type="button" className="chip-button" onClick={() => setEditing(s)}>Edit</button>}
      </span>
    ) },
  ].filter(Boolean), [biz, money]);

  return (
    <div className="stack">
      <BusinessHeader icon="map-pin" title="Sites"
        description="Each contractor's or builder's sites. Bills, quotations and sales orders go to a site; a site's ledger shows its bills, payments and what is still due."
        primary={biz.can("hardware_sites.edit") && <button type="button" className="button" onClick={() => setEditing({ contact_id: customer })}><Icon name="plus" size={16} /> Add a site</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Sites">
        <DataGrid {...list.gridProps} caption="Sites" columns={columns} currency={biz.symbol} rowNoun={["site", "sites"]}
          toolbar={(
            <>
              <label className="field">
                <span>Customer</span>
                <select value={customer} onChange={(e) => setCustomer(e.target.value)}>
                  <option value="">Every customer</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="checkbox bz-check"><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open sites only</label>
              {money && <label className="checkbox bz-check"><input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} /> With money due</label>}
            </>
          )}
          rowClassName={(s) => (!s.active ? "dg-tone-muted" : "")}
          empty="No sites yet" emptyHint="Add a site for a contractor or builder, then choose it on their bills." emptyIcon="map-pin" />
      </SectionCard>
      {editing && <SiteEditDialog site={editing} customers={customers} onClose={() => setEditing(null)}
        onSaved={(s) => { setEditing(null); toast.success(`${s.name} saved.`); list.reload(); }} />}
      {openId && <SiteLedger siteId={openId} onClose={() => setOpenId(null)} onChanged={list.reload} />}
    </div>
  );
}

function SiteEditDialog({ site, customers, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(site.id);
  const [form, setForm] = useState({ contactId: site.contact_id ? String(site.contact_id) : "", name: site.name || "", address: site.address || "",
    contactPerson: site.contact_person || "", phone: site.phone || "", active: site.active ?? true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => {
    const body = { name: form.name.trim(), address: form.address.trim() || null, contactPerson: form.contactPerson.trim() || null, phone: form.phone.trim() || null };
    return editing ? businessWrite(biz.id, `hardware/sites/${site.id}`, { ...body, active: form.active }, "patch")
      : businessWrite(biz.id, "hardware/sites", { ...body, contactId: form.contactId });
  };
  return (
    <FormDialog title={editing ? `Edit ${site.name}` : "Add a site"} icon="map-pin" width={600} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={editing ? `A site stays with ${site.customer_name}. Close it when the work there is done; its bills stay.` : "A site belongs to one customer: the contractor, builder or owner its bills are for."}>
      {!editing && (
        <Field label="Customer" wide>
          <select required value={form.contactId} onChange={set("contactId")}>
            <option value="">Choose the customer…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</option>)}
          </select>
        </Field>
      )}
      <Field label="Site name"><input required maxLength={150} value={form.name} onChange={set("name")} placeholder="e.g. Whitefield villa, Block B" /></Field>
      <Field label="Address (optional)"><input maxLength={500} value={form.address} onChange={set("address")} placeholder="Where the goods are delivered" /></Field>
      <Field label="Contact person at the site (optional)"><input maxLength={150} value={form.contactPerson} onChange={set("contactPerson")} placeholder="e.g. the site supervisor" /></Field>
      <Field label="Their phone (optional)"><input maxLength={30} inputMode="tel" value={form.phone} onChange={set("phone")} /></Field>
      {editing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> Open (new bills, quotations and orders may go here)</label>}
    </FormDialog>
  );
}

export function SiteLedger({ siteId, onClose, onChanged }) {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [billId, setBillId] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `hardware/sites/${siteId}`, undefined, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, siteId, version]);
  const site = data?.site;
  const share = () => {
    const t = data.totals;
    const text = [`*${biz.business.name}*`, `${site.customer_name} · site ${site.name}${site.address ? ` (${site.address})` : ""}`,
      `Billed ${biz.exact(t.billed)}${Number(t.returned) ? ` · goods back ${biz.exact(t.returned)}` : ""} · paid ${biz.exact(t.paid)}`,
      `Due ${biz.exact(t.balance)}`, ...data.bills.filter((b) => Number(b.balance) > 0.004).map((b) => `• ${b.document_no} (${dateShort(b.created_at, { year: true })}): ${biz.exact(b.balance)}`)].join("\n");
    window.open(whatsappLink(site.customer_phone, text), "_blank", "noopener");
  };
  return (
    <>
      <Modal title={site ? `Site ${site.name}` : "Loading…"} icon="map-pin" width={940} onClose={() => { if (!billId) onClose(); }}
        description={site ? [site.customer_name, site.address, site.contact_person && `${site.contact_person}${site.phone ? ` · ${site.phone}` : ""}`].filter(Boolean).join(" · ") : undefined}>
        <ErrorMessage message={error} />
        {!data && !error && <Loading />}
        {data && (
          <div className="stack bz-detail">
            {!site.active && <p className="small muted">This site is closed: new bills, quotations and orders do not go here.</p>}
            {data.money && (
              <div className="bz-totals">
                <span>Billed <strong>{biz.exact(data.totals.billed)}</strong></span>
                {Number(data.totals.returned) > 0 && <span>Goods back <strong>{biz.exact(data.totals.returned)}</strong></span>}
                <span>Paid <strong>{biz.exact(data.totals.paid)}</strong></span>
                <span className={Number(data.totals.balance) > 0.004 ? "bz-due" : ""}>Due <strong>{biz.exact(data.totals.balance)}</strong></span>
              </div>
            )}
            {data.money && (
              <DataGrid variant="compact" id="hardware-site-ledger" caption="Ledger" rows={data.statement} rowKey={(e, i) => `${e.kind}-${e.reference}-${i}`} currency={biz.symbol}
                rowNoun={["entry", "entries"]} empty="Nothing billed to this site yet" columns={[
                  { key: "at", header: "Date", type: "datetime", value: (e) => e.at, render: (e) => dateTime(e.at), mobile: "subtitle" },
                  { key: "kind", header: "What", value: (e) => ENTRY_WORDS[e.kind] || e.kind, mobile: "title" },
                  { key: "reference", header: "Reference", value: (e) => e.reference, className: "mono" },
                  { key: "bill", header: "Bill", value: (e) => e.document_no, render: (e) => (biz.can("sales.view") ? <button type="button" className="link-button mono" onClick={() => setBillId(e.document_id)}>{e.document_no}</button> : e.document_no) },
                  { key: "amount", header: "Amount", type: "money", exact: true, value: (e) => Number(e.amount), mobile: "show" },
                  { key: "balance", header: "Balance", type: "money", exact: true, value: (e) => Number(e.balance) },
                ]} />
            )}
            {!data.money && <p className="small muted">Your role does not see sales, so the site's bills and payments are not shown.</p>}
            {data.quotations.length > 0 && (
              <div>
                <p className="section-heading">Quotations</p>
                <ul className="bz-history">
                  {data.quotations.map((q) => {
                    const state = q.expired ? "expired" : q.status;
                    return <li key={q.id}><Badge tone={STATES[state]?.tone} label={STATES[state]?.label || state} /> <Link className="mono" to={businessPath(biz.id, `quotations?quotation=${q.id}`)}>{q.quotation_no}</Link> · {biz.exact(q.total)} · valid until {dateShort(q.valid_until, { year: true })}</li>;
                  })}
                </ul>
              </div>
            )}
            {data.orders.length > 0 && (
              <div>
                <p className="section-heading">Sales orders</p>
                <ul className="bz-history">
                  {data.orders.map((o) => <li key={o.id}><Badge status={o.status} label={o.status.replace("_", " ")} /> <Link className="mono" to={businessPath(biz.id, `sales-orders?order=${o.id}`)}>{o.order_no}</Link> · {biz.exact(o.total)}{o.expected_on ? ` · wanted by ${dateShort(o.expected_on, { year: true })}` : ""}</li>)}
                </ul>
              </div>
            )}
            <div className="form-actions bz-start">
              {biz.has("quotations") && biz.can("quotations.create") && site.active && (
                <Link className="button button-secondary" to={businessPath(biz.id, `quotations?new=1&customer=${site.contact_id}&site=${site.id}`)}><Icon name="clipboard" size={15} /> New quotation for this site</Link>
              )}
              {data.money && <button type="button" className="button button-secondary" onClick={share}><Icon name="message" size={15} /> Send the dues on WhatsApp</button>}
            </div>
          </div>
        )}
      </Modal>
      {billId && <DocumentDetail documentId={billId} onClose={() => setBillId(null)} onChanged={() => { setVersion((n) => n + 1); onChanged?.(); }} />}
    </>
  );
}
